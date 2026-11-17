// MCP: Streamable HTTP, JSON-RPC 2.0, the modern 2026-07-28 era. Written
// from the suite's own client behavior (server/discover, initialize,
// tools/list, tools/call) and the checks it runs, not copied from any
// other project.
//
//   POST /mcp
//   server/discover -> supportedVersions (incl. 2026-07-28), capabilities,
//     serverInfo (also under _meta['io.modelcontextprotocol/serverInfo'])
//   initialize     -> echo the offered revision, capabilities.tools, serverInfo
//   tools/list     -> the six canonical tools, byte-identical every call
//   tools/call     -> {content:[{type:'text',text:<JSON>}], structuredContent:<same>}
//                     unknown tool -> -32602/-32601; missing args -> isError / -32602
//   Auth is decided before any tool exists: no Authorization header -> HTTP 401.

import { VIEWER_LOGIN, timestampOf, type Store } from './store.ts';
import { trySquashMerge } from './rest.ts';

export interface McpResult {
  status: number;
  body: string;
}

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const LATEST_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2025-03-26', '2025-06-18', '2026-07-28'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by squash.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Run one tool against the store; throws an Error whose message is the tool error text. */
function runTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const number = (value: unknown): number => (typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10));
  switch (name) {
    case 'create_repo': {
      const repoName = text(args.name);
      if (repoName === '') throw new Error('name is required');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) throw new Error(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(repoName, VIEWER_LOGIN, text(args.description), args.private === true);
      return { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch };
    }
    case 'get_repo': {
      const repo = store.getRepo(text(args.owner), text(args.repo));
      if (repo === undefined) throw new Error('Repository not found');
      return { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch };
    }
    case 'create_issue': {
      const repo = store.getRepo(text(args.owner), text(args.repo));
      if (repo === undefined) throw new Error('Repository not found');
      const title = text(args.title);
      if (title === '') throw new Error('title is required');
      const issue = store.createIssue(repo, title, text(args.body), []);
      return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
    }
    case 'list_issues': {
      const repo = store.getRepo(text(args.owner), text(args.repo));
      if (repo === undefined) throw new Error('Repository not found');
      const state = text(args.state) || 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return {
        issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(text(args.owner), text(args.repo));
      if (repo === undefined) throw new Error('Repository not found');
      const head = text(args.head);
      const base = text(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) throw new Error('head or base branch does not exist');
      const pull = store.createPull(repo, text(args.title), text(args.body), head, base, headSha, baseSha);
      return { id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(text(args.owner), text(args.repo));
      if (repo === undefined) throw new Error('Repository not found');
      const pull = repo.pulls.find((item) => item.number === number(args.pull_number));
      if (pull === undefined) throw new Error('Pull request not found');
      if (pull.state !== 'open') throw new Error('Pull request is not open');
      const merged = trySquashMerge(store, repo, pull);
      if (merged === null) throw new Error('Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = merged.sha;
      pull.mergedAt = timestampOf(store.nextSeq());
      return { number: pull.number, merged: true, state: pull.state, merge_commit_sha: pull.mergeCommitSha };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export function handleMcp(store: Store, rawBody: Buffer): McpResult {
  let request: RpcRequest;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as RpcRequest;
  } catch {
    return {
      status: 400,
      body: `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
    };
  }
  const id = request.id ?? null;
  const method = request.method ?? '';
  const params = request.params ?? {};

  if (method === 'server/discover') {
    return {
      status: 200,
      body: `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        },
      })}\n`,
    };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_REVISION;
    return {
      status: 200,
      body: `${JSON.stringify(
        rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_REVISION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      )}\n`,
    };
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  if (method === 'ping') {
    return { status: 200, body: `${JSON.stringify(rpcResult(id, {}))}\n` };
  }

  if (method === 'tools/list') {
    // Byte-identical every call: the same constant string.
    return { status: 200, body: `${JSON.stringify(rpcResult(id, JSON.parse(TOOLS_LIST_JSON)))}\n` };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((item) => item.name === toolName);
    if (tool === undefined) {
      return { status: 200, body: `${JSON.stringify(rpcError(id, -32602, `unknown tool ${toolName}`))}\n` };
    }
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      const text = JSON.stringify({ error: `missing required argument(s): ${missing.join(', ')}` });
      return {
        status: 200,
        body: `${JSON.stringify(rpcResult(id, { content: [{ type: 'text', text }], structuredContent: { error: `missing required argument(s): ${missing.join(', ')}` }, isError: true }))}\n`,
      };
    }
    try {
      const result = runTool(store, toolName, args);
      const text = JSON.stringify(result);
      return {
        status: 200,
        body: `${JSON.stringify(rpcResult(id, { content: [{ type: 'text', text }], structuredContent: result }))}\n`,
      };
    } catch (err) {
      const text = JSON.stringify({ error: err instanceof Error ? err.message : 'tool failed' });
      return {
        status: 200,
        body: `${JSON.stringify(rpcResult(id, { content: [{ type: 'text', text }], structuredContent: { error: err instanceof Error ? err.message : 'tool failed' }, isError: true }))}\n`,
      };
    }
  }

  return { status: 200, body: `${JSON.stringify(rpcError(id, -32601, `Method not found: ${method}`))}\n` };
}
