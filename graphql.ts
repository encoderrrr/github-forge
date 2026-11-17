// GraphQL v4: a small hand-written parser and executor for exactly the
// documents the suite sends — viewer, repository, issues, pull requests,
// mutations, node lookup, __type introspection, batched requests.
// Written from the suite's own client behavior and checks, not copied from
// any other project. No schema library, no dependencies.
//
// Supported: operations (query/mutation, named or shorthand), variables,
// inline input objects, inline enum lists, inline fragments (`... on T`),
// batched JSON arrays, operationName selection. Unknown fields are reported
// as GraphQL errors (HTTP 200 with an `errors` array) per the spec.

import {
  EPOCH_SEC,
  VIEWER_LOGIN,
  decodeGlobalId,
  globalId,
  timestampOf,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === ':' || ch === '!' || ch === '$' || ch === '=' || ch === '[' || ch === ']' || ch === '@') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j]!;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Argument {
  name: string;
  value: Value;
}

interface Field {
  alias: string;
  name: string;
  args: Argument[];
  selection: Selection[];
}

type Selection =
  | { kind: 'field'; field: Field }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: Selection[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value>;
  selection: Selection[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selection: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  public readonly fragments: Map<string, FragmentDefinition>;
  constructor(tokens: Token[], fragments = new Map<string, FragmentDefinition>()) {
    this.tokens = tokens;
    this.fragments = fragments;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: {}, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        this.fragments.set(name, { name, typeCondition, selection });
        continue;
      }
      const keyword = this.expectName();
      if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unsupported operation ${keyword}`);
      let name: string | null = null;
      if (this.peek()?.kind === 'name') name = this.next().value;
      let variables: Record<string, Value> = {};
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') variables = this.parseVariableDefinitions();
      operations.push({ operation: keyword as 'query' | 'mutation', name, variables, selection: this.parseSelectionSet() });
    }
    return operations;
  }

  private parseVariableDefinitions(): Record<string, Value> {
    this.expectPunct('(');
    const variables: Record<string, Value> = {};
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
        this.next();
        variables[name] = this.parseValue();
      } else {
        variables[name] = { kind: 'null' };
      }
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): void {
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (next?.kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.next().value });
        } else {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): Field {
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: Argument[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.next();
    }
    // Directives are ignored.
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.next();
      }
    }
    let selection: Selection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

function argValue(field: Field, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((item) => item.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, variables);
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'comments'];
const PULL_REQUEST_FIELDS = [
  'id',
  'number',
  'title',
  'body',
  'state',
  'merged',
  'headRefName',
  'baseRefName',
  'mergeable',
  'files',
  'url',
  'createdAt',
  'updatedAt',
];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'description',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
  'url',
  'createdAt',
  'isPrivate',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT', 'WIKI', 'PACKAGE', 'TOPIC'];

function pageCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isNaN(number) ? null : number;
  } catch {
    return null;
  }
}

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
  errors: Array<{ message: string }>;
}

function error(exec: Executor, message: string): void {
  exec.errors.push({ message });
}

/** The three-way conflict test, shared with the REST merge. */
function isMergeable(store: Store, repo: Repo, pull: PullRequest): boolean {
  const base = store.mergeBase(repo, pull.baseSha, pull.headSha);
  if (base === undefined) return false;
  const baseFiles = store.flattenTree(repo, base);
  const headFiles = store.flattenTree(repo, pull.headSha);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip === undefined) return false;
  const defaultFiles = store.flattenTree(repo, defaultTip);
  for (const [path, head] of headFiles) {
    const baseEntry = baseFiles.get(path);
    const defaultEntry = defaultFiles.get(path);
    if (baseEntry?.oid !== head.oid && defaultEntry?.oid !== head.oid && defaultEntry?.oid !== baseEntry?.oid) return false;
  }
  for (const [path, baseEntry] of baseFiles) {
    if (!headFiles.has(path) && defaultFiles.get(path)?.oid !== baseEntry.oid) return false;
  }
  return true;
}

function issueObject(exec: Executor, repo: Repo, issue: Issue, selection: Selection[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of selectionFields(exec, selection)) {
    switch (field.name) {
      case 'id':
        out[field.alias] = globalId('Issue', repo.id, issue.number);
        break;
      case 'databaseId':
        out[field.alias] = issue.id;
        break;
      case 'number':
        out[field.alias] = issue.number;
        break;
      case 'title':
        out[field.alias] = issue.title;
        break;
      case 'state':
        out[field.alias] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'body':
        out[field.alias] = issue.body;
        break;
      case 'url':
        out[field.alias] = `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        break;
      case 'createdAt':
        out[field.alias] = issue.createdAt;
        break;
      case 'updatedAt':
        out[field.alias] = issue.updatedAt;
        break;
      case 'comments': {
        const first = argValue(field, 'first', exec.variables);
        const comments = issue.comments.slice(0, typeof first === 'number' ? first : issue.comments.length);
        const nodesField = selectionFields(exec, field.selection).find((item) => item.name === 'nodes');
        const nodeSelection = nodesField?.selection ?? [];
        out[field.alias] = {
          nodes: comments.map((comment) => {
            const node: Record<string, JsonValue> = {};
            for (const sub of selectionFields(exec, nodeSelection)) {
              if (sub.name === 'id') node[sub.alias] = String(comment.id);
              else if (sub.name === 'body') node[sub.alias] = comment.body;
              else {
                error(exec, `Cannot query field "${sub.name}" on type "IssueComment".`);
                node[sub.alias] = null;
              }
            }
            return node;
          }),
        };
        break;
      }
      default:
        error(exec, `Cannot query field "${field.name}" on type "Issue".`);
        out[field.alias] = null;
    }
  }
  return out;
}

function pullObject(exec: Executor, repo: Repo, pull: PullRequest, selection: Selection[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of selectionFields(exec, selection)) {
    switch (field.name) {
      case 'id':
        out[field.alias] = globalId('PullRequest', repo.id, pull.number);
        break;
      case 'databaseId':
        out[field.alias] = pull.id;
        break;
      case 'number':
        out[field.alias] = pull.number;
        break;
      case 'title':
        out[field.alias] = pull.title;
        break;
      case 'body':
        out[field.alias] = pull.body;
        break;
      case 'state':
        out[field.alias] = pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
        break;
      case 'merged':
        out[field.alias] = pull.merged;
        break;
      case 'headRefName':
        out[field.alias] = pull.headRef;
        break;
      case 'baseRefName':
        out[field.alias] = pull.baseRef;
        break;
      case 'mergeable':
        out[field.alias] = isMergeable(exec.store, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        break;
      case 'files': {
        const base = exec.store.mergeBase(repo, pull.baseSha, pull.headSha);
        const baseFiles = base === undefined ? new Map() : exec.store.flattenTree(repo, base);
        const headFiles = exec.store.flattenTree(repo, pull.headSha);
        const paths: Array<{ path: string }> = [];
        for (const path of headFiles.keys()) if (!baseFiles.has(path) || baseFiles.get(path)!.oid !== headFiles.get(path)!.oid) paths.push({ path });
        paths.sort((a, b) => (a.path < b.path ? -1 : 1));
        const first = argValue(field, 'first', exec.variables);
        const page = typeof first === 'number' ? paths.slice(0, first) : paths;
        const nodesField = selectionFields(exec, field.selection).find((item) => item.name === 'nodes');
        const nodeSelection = nodesField?.selection ?? [];
        out[field.alias] = {
          nodes: page.map((entry) => {
            const node: Record<string, JsonValue> = {};
            for (const sub of selectionFields(exec, nodeSelection)) {
              if (sub.name === 'path') node[sub.alias] = entry.path;
              else {
                error(exec, `Cannot query field "${sub.name}" on type "PullRequestChangedFile".`);
                node[sub.alias] = null;
              }
            }
            return node;
          }),
        };
        break;
      }
      case 'url':
        out[field.alias] = `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
        break;
      case 'createdAt':
        out[field.alias] = pull.createdAt;
        break;
      case 'updatedAt':
        out[field.alias] = pull.updatedAt;
        break;
      default:
        error(exec, `Cannot query field "${field.name}" on type "PullRequest".`);
        out[field.alias] = null;
    }
  }
  return out;
}

function repoObject(exec: Executor, repo: Repo, selection: Selection[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of selectionFields(exec, selection)) {
    switch (field.name) {
      case 'id':
        out[field.alias] = globalId('Repository', repo.id);
        break;
      case 'databaseId':
        out[field.alias] = repo.id;
        break;
      case 'name':
        out[field.alias] = repo.name;
        break;
      case 'nameWithOwner':
        out[field.alias] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[field.alias] = { login: repo.owner };
        break;
      case 'description':
        out[field.alias] = repo.description;
        break;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[field.alias] = tip === undefined ? null : { name: repo.defaultBranch };
        break;
      }
      case 'viewerPermission':
        out[field.alias] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[field.alias] = true;
        break;
      case 'url':
        out[field.alias] = `https://github.com/${repo.owner}/${repo.name}`;
        break;
      case 'createdAt':
        out[field.alias] = timestampOf(repo.createdSeq);
        break;
      case 'isPrivate':
        out[field.alias] = repo.private;
        break;
      case 'issue': {
        const number = argValue(field, 'number', exec.variables);
        const issue = typeof number === 'number' ? repo.issues.find((item) => item.number === number) : undefined;
        out[field.alias] = issue === undefined ? null : issueObject(exec, repo, issue, field.selection);
        break;
      }
      case 'issues': {
        const first = argValue(field, 'first', exec.variables);
        const after = argValue(field, 'after', exec.variables);
        const states = argValue(field, 'states', exec.variables);
        const orderBy = argValue(field, 'orderBy', exec.variables) as { field?: string; direction?: string } | undefined;
        let issues = [...repo.issues];
        if (Array.isArray(states) && states.length > 0) {
          issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const direction = orderBy?.direction === 'ASC' ? 1 : -1;
        issues.sort((a, b) => direction * (a.number - b.number));
        if (typeof after === 'string') {
          const afterNumber = cursorNumber(after);
          if (afterNumber !== null) issues = issues.filter((issue) => (direction > 0 ? issue.number > afterNumber : issue.number < afterNumber));
        }
        const limit = typeof first === 'number' ? first : issues.length;
        const page = issues.slice(0, limit);
        const hasNext = issues.length > limit;
        const nodesField = selectionFields(exec, field.selection).find((item) => item.name === 'nodes');
        const nodeSelection = nodesField?.selection ?? [];
        out[field.alias] = {
          nodes: page.map((issue) => issueObject(exec, repo, issue, nodeSelection)),
          pageInfo: {
            hasNextPage: hasNext,
            endCursor: page.length > 0 ? pageCursor(page[page.length - 1]!.number) : null,
          },
        };
        break;
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', exec.variables);
        const pull = typeof number === 'number' ? repo.pulls.find((item) => item.number === number) : undefined;
        out[field.alias] = pull === undefined ? null : pullObject(exec, repo, pull, field.selection);
        break;
      }
      case 'pullRequests': {
        const first = argValue(field, 'first', exec.variables);
        const after = argValue(field, 'after', exec.variables);
        let pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
        if (typeof after === 'string') {
          const afterNumber = cursorNumber(after);
          if (afterNumber !== null) pulls = pulls.filter((pull) => pull.number < afterNumber);
        }
        const limit = typeof first === 'number' ? first : pulls.length;
        const page = pulls.slice(0, limit);
        const nodesField = selectionFields(exec, field.selection).find((item) => item.name === 'nodes');
        const nodeSelection = nodesField?.selection ?? [];
        out[field.alias] = {
          nodes: page.map((pull) => pullObject(exec, repo, pull, nodeSelection)),
          pageInfo: {
            hasNextPage: pulls.length > limit,
            endCursor: page.length > 0 ? pageCursor(page[page.length - 1]!.number) : null,
          },
        };
        break;
      }
      default:
        error(exec, `Cannot query field "${field.name}" on type "Repository".`);
        out[field.alias] = null;
    }
  }
  return out;
}

/** Expand inline fragments and fragment spreads into a flat field list. */
function selectionFields(exec: Executor, selection: Selection[]): Field[] {
  const fields: Field[] = [];
  for (const item of selection) {
    if (item.kind === 'field') fields.push(item.field);
    else if (item.kind === 'inlineFragment') fields.push(...selectionFields(exec, item.selection));
    else if (item.kind === 'fragmentSpread') {
      const fragment = exec.fragments.get(item.name);
      if (fragment !== undefined) fields.push(...selectionFields(exec, fragment.selection));
    }
  }
  return fields;
}

function findRepoByDatabaseId(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>, fragments: Map<string, FragmentDefinition>): { data: Record<string, JsonValue>; errors?: Array<{ message: string }> } {
  const exec: Executor = { store, variables, fragments, errors: [] };
  const data: Record<string, JsonValue> = {};
  for (const field of selectionFields(exec, op.selection)) {
    if (op.operation === 'query') {
      switch (field.name) {
        case 'viewer': {
          const user: Record<string, JsonValue> = {};
          for (const sub of selectionFields(exec, field.selection)) {
            if (sub.name === 'login') user[sub.alias] = VIEWER_LOGIN;
            else {
              error(exec, `Cannot query field "${sub.name}" on type "User".`);
              user[sub.alias] = null;
            }
          }
          data[field.alias] = user;
          break;
        }
        case 'repository': {
          const owner = argValue(field, 'owner', exec.variables);
          const name = argValue(field, 'name', exec.variables);
          const repo = typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) : undefined;
          data[field.alias] = repo === undefined ? null : repoObject(exec, repo, field.selection);
          break;
        }
        case 'node': {
          const id = argValue(field, 'id', exec.variables);
          const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
          let node: Record<string, JsonValue> | null = null;
          if (decoded !== null) {
            if (decoded.kind === 'Repository') {
              const repo = findRepoByDatabaseId(store, Number.parseInt(decoded.parts[0] ?? '0', 10));
              if (repo !== undefined) node = repoObject(exec, repo, field.selection);
            } else if (decoded.kind === 'Issue') {
              const repo = findRepoByDatabaseId(store, Number.parseInt(decoded.parts[0] ?? '0', 10));
              const issue = repo?.issues.find((item) => item.number === Number.parseInt(decoded.parts[1] ?? '0', 10));
              if (repo !== undefined && issue !== undefined) node = issueObject(exec, repo, issue, field.selection);
            } else if (decoded.kind === 'PullRequest') {
              const repo = findRepoByDatabaseId(store, Number.parseInt(decoded.parts[0] ?? '0', 10));
              const pull = repo?.pulls.find((item) => item.number === Number.parseInt(decoded.parts[1] ?? '0', 10));
              if (repo !== undefined && pull !== undefined) node = pullObject(exec, repo, pull, field.selection);
            }
          }
          data[field.alias] = node;
          break;
        }
        case '__type': {
          const name = argValue(field, 'name', exec.variables);
          const typeOut: Record<string, JsonValue> = {};
          for (const sub of selectionFields(exec, field.selection)) {
            if (sub.name === 'name') typeOut[sub.alias] = typeof name === 'string' ? name : null;
            else if (sub.name === 'fields') {
              const list = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PULL_REQUEST_FIELDS : name === 'Repository' ? REPOSITORY_FIELDS : [];
              typeOut[sub.alias] = list.map((fieldName) => ({ name: fieldName }));
            } else if (sub.name === 'enumValues') {
              typeOut[sub.alias] = name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => ({ name: value })) : [];
            } else {
              error(exec, `Cannot query field "${sub.name}" on type "__Type".`);
              typeOut[sub.alias] = null;
            }
          }
          data[field.alias] = typeOut;
          break;
        }
        case '__schema':
          data[field.alias] = { queryType: { name: 'Query' } };
          break;
        default:
          error(exec, `Cannot query field "${field.name}" on type "Query".`);
          data[field.alias] = null;
      }
    } else {
      // Mutations.
      switch (field.name) {
        case 'createIssue': {
          const input = argValue(field, 'input', exec.variables) as Record<string, unknown> | undefined;
          const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
          const decoded = decodeGlobalId(repositoryId);
          const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoByDatabaseId(store, Number.parseInt(decoded.parts[0] ?? '0', 10)) : undefined;
          if (repo === undefined) {
            error(exec, 'Repository not found for createIssue.');
            data[field.alias] = null;
            break;
          }
          const title = typeof input?.title === 'string' ? input.title : '';
          const bodyText = typeof input?.body === 'string' ? input.body : '';
          const issue = store.createIssue(repo, title, bodyText, []);
          const out: Record<string, JsonValue> = {};
          for (const sub of selectionFields(exec, field.selection)) {
            if (sub.name === 'issue') out[sub.alias] = issueObject(exec, repo, issue, sub.selection);
            else {
              error(exec, `Cannot query field "${sub.name}" on type "CreateIssuePayload".`);
              out[sub.alias] = null;
            }
          }
          data[field.alias] = out;
          break;
        }
        case 'closeIssue': {
          const input = argValue(field, 'input', exec.variables) as Record<string, unknown> | undefined;
          const issueId = typeof input?.issueId === 'string' ? input.issueId : '';
          const decoded = decodeGlobalId(issueId);
          const repo = decoded !== null && decoded.kind === 'Issue' ? findRepoByDatabaseId(store, Number.parseInt(decoded.parts[0] ?? '0', 10)) : undefined;
          const issue = repo?.issues.find((item) => item.number === Number.parseInt(decoded?.parts[1] ?? '0', 10));
          if (repo === undefined || issue === undefined) {
            error(exec, 'Issue not found for closeIssue.');
            data[field.alias] = null;
            break;
          }
          issue.state = 'closed';
          const out: Record<string, JsonValue> = {};
          for (const sub of selectionFields(exec, field.selection)) {
            if (sub.name === 'issue') out[sub.alias] = issueObject(exec, repo, issue, sub.selection);
            else {
              error(exec, `Cannot query field "${sub.name}" on type "CloseIssuePayload".`);
              out[sub.alias] = null;
            }
          }
          data[field.alias] = out;
          break;
        }
        case 'createPullRequest': {
          const input = argValue(field, 'input', exec.variables) as Record<string, unknown> | undefined;
          const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
          const decoded = decodeGlobalId(repositoryId);
          const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoByDatabaseId(store, Number.parseInt(decoded.parts[0] ?? '0', 10)) : undefined;
          if (repo === undefined) {
            error(exec, 'Repository not found for createPullRequest.');
            data[field.alias] = null;
            break;
          }
          const headRef = typeof input?.headRefName === 'string' ? input.headRefName : '';
          const baseRef = typeof input?.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha === undefined || baseSha === undefined) {
            error(exec, 'head or base branch does not exist for createPullRequest.');
            data[field.alias] = null;
            break;
          }
          const pull = store.createPull(repo, typeof input?.title === 'string' ? input.title : '', typeof input?.body === 'string' ? input.body : '', headRef, baseRef, headSha, baseSha);
          const out: Record<string, JsonValue> = {};
          for (const sub of selectionFields(exec, field.selection)) {
            if (sub.name === 'pullRequest') out[sub.alias] = pullObject(exec, repo, pull, sub.selection);
            else {
              error(exec, `Cannot query field "${sub.name}" on type "CreatePullRequestPayload".`);
              out[sub.alias] = null;
            }
          }
          data[field.alias] = out;
          break;
        }
        case 'mergePullRequest': {
          const input = argValue(field, 'input', exec.variables) as Record<string, unknown> | undefined;
          const pullRequestId = typeof input?.pullRequestId === 'string' ? input.pullRequestId : '';
          const decoded = decodeGlobalId(pullRequestId);
          const repo = decoded !== null && decoded.kind === 'PullRequest' ? findRepoByDatabaseId(store, Number.parseInt(decoded.parts[0] ?? '0', 10)) : undefined;
          const pull = repo?.pulls.find((item) => item.number === Number.parseInt(decoded?.parts[1] ?? '0', 10));
          if (repo === undefined || pull === undefined) {
            error(exec, 'Pull request not found for mergePullRequest.');
            data[field.alias] = null;
            break;
          }
          if (pull.state === 'open' && isMergeable(store, repo, pull)) {
            // Squash-merge onto the default branch (same three-way merge as REST).
            const base = store.mergeBase(repo, pull.baseSha, pull.headSha);
            const baseFiles = base === undefined ? new Map() : store.flattenTree(repo, base);
            const headFiles = store.flattenTree(repo, pull.headSha);
            const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
            if (defaultTip !== undefined) {
              const merged = new Map(store.flattenTree(repo, defaultTip));
              for (const [path, head] of headFiles) {
                const baseEntry = baseFiles.get(path);
                if (baseEntry?.oid !== head.oid) merged.set(path, head);
              }
              for (const [path, baseEntry] of baseFiles) {
                if (!headFiles.has(path)) merged.delete(path);
              }
              const treeOid = store.buildTreeFromFiles(repo, merged);
              const seq = store.nextSeq();
              const identity = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@users.noreply.github.com>`;
              const commit = store.putObject(
                repo,
                'commit',
                Buffer.from(
                  `tree ${treeOid}\nparent ${defaultTip}\nauthor ${identity} ${EPOCH_SEC + seq} +0000\ncommitter ${identity} ${EPOCH_SEC + seq} +0000\n\n${pull.title}\n`,
                  'utf8',
                ),
              );
              repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
              pull.merged = true;
              pull.state = 'closed';
              pull.mergeCommitSha = commit;
              pull.mergedAt = timestampOf(seq);
            }
          }
          const out: Record<string, JsonValue> = {};
          for (const sub of selectionFields(exec, field.selection)) {
            if (sub.name === 'pullRequest') out[sub.alias] = pullObject(exec, repo, pull, sub.selection);
            else {
              error(exec, `Cannot query field "${sub.name}" on type "MergePullRequestPayload".`);
              out[sub.alias] = null;
            }
          }
          data[field.alias] = out;
          break;
        }
        case 'addComment': {
          const input = argValue(field, 'input', exec.variables) as Record<string, unknown> | undefined;
          const subjectId = typeof input?.subjectId === 'string' ? input.subjectId : '';
          const decoded = decodeGlobalId(subjectId);
          const repo = decoded !== null && decoded.kind === 'Issue' ? findRepoByDatabaseId(store, Number.parseInt(decoded.parts[0] ?? '0', 10)) : undefined;
          const issue = repo?.issues.find((item) => item.number === Number.parseInt(decoded?.parts[1] ?? '0', 10));
          if (repo === undefined || issue === undefined) {
            error(exec, 'Issue not found for addComment.');
            data[field.alias] = null;
            break;
          }
          const comment = store.createComment(issue, typeof input?.body === 'string' ? input.body : '');
          const out: Record<string, JsonValue> = {};
          for (const sub of selectionFields(exec, field.selection)) {
            if (sub.name === 'commentEdge') {
              const edge: Record<string, JsonValue> = {};
              for (const edgeField of selectionFields(exec, sub.selection)) {
                if (edgeField.name === 'node') edge[edgeField.alias] = { id: String(comment.id), body: comment.body };
                else {
                  error(exec, `Cannot query field "${edgeField.name}" on type "IssueCommentEdge".`);
                  edge[edgeField.alias] = null;
                }
              }
              out[sub.alias] = edge;
            } else {
              error(exec, `Cannot query field "${sub.name}" on type "AddCommentPayload".`);
              out[sub.alias] = null;
            }
          }
          data[field.alias] = out;
          break;
        }
        default:
          error(exec, `Cannot query field "${field.name}" on type "Mutation".`);
          data[field.alias] = null;
      }
    }
  }
  const result: { data: Record<string, JsonValue>; errors?: Array<{ message: string }> } = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}

/** Execute one GraphQL request body (single or batched). */
export function handleGraphQL(
  store: Store,
  body: unknown,
): { status: number; body: string } {
  const runOne = (request: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof request.query === 'string' ? request.query : '';
    const variables = (request.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof request.operationName === 'string' ? request.operationName : null;
    let operations: Operation[];
    let fragments = new Map<string, FragmentDefinition>();
    try {
      const parser = new Parser(lex(query));
      operations = parser.parseDocument();
      fragments = parser.fragments;
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'empty GraphQL document' }] };
    const op =
      operationName !== null
        ? operations.find((item) => item.name === operationName)
        : operations[0];
    if (op === undefined) return { errors: [{ message: `unknown operation ${operationName}` }] };
    return executeOperation(store, op, variables, fragments);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: `${JSON.stringify(body.map((item) => runOne((item ?? {}) as Record<string, unknown>)))}\n` };
  }
  return { status: 200, body: `${JSON.stringify(runOne((body ?? {}) as Record<string, unknown>))}\n` };
}
