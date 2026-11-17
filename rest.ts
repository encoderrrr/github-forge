// REST API v3: the /api/v3 surface the suite exercises — repositories, refs,
// branches, commits, contents, labels, issues, comments, pull requests.
// Written from the suite's own client behavior and the checks it runs, not
// copied from any other project.
//
// Conventions the suite relies on:
//   - every reply is JSON (never HTML), with a non-empty X-GitHub-Request-Id;
//   - 401/404/422 bodies carry a string `message`;
//   - unknown routes answer 404 JSON; a malformed JSON body answers 400 JSON;
//   - issue/PR/repo JSON carries stable numeric `id` fields;
//   - pagination lists carry a Link header with rel="next" when more pages exist.

import {
  EPOCH_SEC,
  isObjectId,
  parseCommit,
  parseTree,
  VIEWER_LOGIN,
  globalId,
  timestampOf,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

type Body = Record<string, unknown> | unknown[] | null;

const json = (status: number, body: Body, headers: Record<string, string> = {}): RestResult => ({
  status,
  headers,
  body: body === null ? '' : `${JSON.stringify(body)}\n`,
});

const message = (status: number, text: string): RestResult => json(status, { message: text });
const notFound = (text = 'Not Found'): RestResult => message(404, text);
const unprocessable = (text: string): RestResult => message(422, text);

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = { login: repo.owner, id: repo.id, type: repo.owner.endsWith('-org') ? 'Organization' : 'User' };
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: timestampOf(repo.createdSeq),
    updated_at: timestampOf(repo.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** The commits on a branch, newest first. */
function branchCommits(repo: Repo, tip: string): Array<{ sha: string; commit: { message: string } }> {
  const out: Array<{ sha: string; commit: { message: string } }> = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push({ sha: oid, commit: { message: parseCommit(object.data).message } });
    queue.push(...parseCommit(object.data).parents);
  }
  return out;
}

/** Line counts for a two-file diff (added/deleted lines). */
function diffLineCounts(a: string, b: string): { additions: number; deletions: number } {
  const aLines = a === '' ? [] : a.split('\n');
  const bLines = b === '' ? [] : b.split('\n');
  const common = new Set(aLines);
  let additions = 0;
  let deletions = 0;
  for (const line of bLines) if (!common.has(line)) additions += 1;
  for (const line of aLines) if (!new Set(bLines).has(line)) deletions += 1;
  return { additions, deletions };
}

function pullFiles(store: Store, repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
  const base = store.mergeBase(repo, pull.baseSha, pull.headSha);
  const baseFiles = base === undefined ? new Map() : store.flattenTree(repo, base);
  const headFiles = store.flattenTree(repo, pull.headSha);
  const files: Array<Record<string, unknown>> = [];
  for (const [path, head] of headFiles) {
    const baseEntry = baseFiles.get(path);
    if (baseEntry === undefined) {
      const content = repo.objects.get(head.oid)?.data.toString('utf8') ?? '';
      const { additions } = diffLineCounts('', content);
      files.push({
        filename: path,
        status: 'added',
        additions: Math.max(1, additions),
        deletions: 0,
        changes: Math.max(1, additions),
      });
    } else if (baseEntry.oid !== head.oid) {
      const a = repo.objects.get(baseEntry.oid)?.data.toString('utf8') ?? '';
      const b = repo.objects.get(head.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = diffLineCounts(a, b);
      files.push({
        filename: path,
        status: 'modified',
        additions: Math.max(1, additions),
        deletions,
        changes: Math.max(1, additions + deletions),
      });
    }
  }
  files.sort((x, y) => String(x.filename).localeCompare(String(y.filename)));
  return files;
}

/** Try to merge a PR by squash; answer null when it conflicts. */
export function trySquashMerge(store: Store, repo: Repo, pull: PullRequest): { sha: string } | null {
  const base = store.mergeBase(repo, pull.baseSha, pull.headSha);
  if (base === undefined) return null;
  const baseFiles = store.flattenTree(repo, base);
  const headFiles = store.flattenTree(repo, pull.headSha);
  const defaultTip = store.branchTip(repo, repo.defaultBranch);
  if (defaultTip === undefined) return null;
  const defaultFiles = store.flattenTree(repo, defaultTip);
  // Three-way: a file changed on both sides with different results conflicts.
  const merged = new Map<string, { oid: string; mode: string }>(defaultFiles);
  for (const [path, head] of headFiles) {
    const baseEntry = baseFiles.get(path);
    const defaultEntry = defaultFiles.get(path);
    const baseChanged = baseEntry?.oid !== head.oid;
    const defaultChanged = defaultEntry?.oid !== head.oid;
    const defaultDiffersFromBase = defaultEntry?.oid !== baseEntry?.oid;
    if (baseChanged && defaultChanged && defaultDiffersFromBase) return null;
    if (baseChanged) merged.set(path, head);
  }
  for (const [path, baseEntry] of baseFiles) {
    if (!headFiles.has(path)) {
      const defaultEntry = defaultFiles.get(path);
      if (defaultEntry?.oid !== baseEntry.oid) return null;
      merged.delete(path);
    }
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
  return { sha: commit };
}

function pagination(
  total: number,
  perPage: number,
  page: number,
  baseUrl: string,
): { headers: Record<string, string>; slice: [number, number] } {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const headers: Record<string, string> = {};
  if (page < pages) {
    const next = `${baseUrl}?per_page=${perPage}&page=${page + 1}`;
    headers.Link = `<${next}>; rel="next"`;
  }
  return { headers, slice: [(page - 1) * perPage, page * perPage] };
}

interface RestContext {
  store: Store;
  /** The absolute same-origin base, e.g. http://127.0.0.1:54321, for Link headers. */
  origin: string;
}

export function handleRest(
  ctx: RestContext,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const store = ctx.store;
  const segments = pathname.split('/').filter((part) => part !== '');

  // GET /api/v3/
  if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    return json(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta
  if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
    return json(200, { installed_version: '1.0.0' });
  }
  // GET /api/v3/user
  if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user') {
    return json(200, { login: VIEWER_LOGIN, id: 1, type: 'User' });
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    const data = (body ?? {}) as Record<string, unknown>;
    const name = typeof data.name === 'string' ? data.name : '';
    if (name === '') return unprocessable('name is required');
    if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return unprocessable(`Repository ${VIEWER_LOGIN}/${name} already exists`);
    const repo = store.createRepo(
      name,
      VIEWER_LOGIN,
      typeof data.description === 'string' ? data.description : '',
      data.private === true,
    );
    return json(201, repoJson(repo));
  }

  // GET /api/v3/user/repos
  if (method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
    const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    const repos = store.ownerRepos(VIEWER_LOGIN);
    const { headers, slice } = pagination(repos.length, perPage, page, `${ctx.origin}/api/v3/user/repos`);
    return json(200, repos.slice(...slice).map((repo) => repoJson(repo)), headers);
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 5 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3]!);
    const repoName = decodeURIComponent(segments[4]!);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return notFound('Repository not found');
    const tail = segments.slice(5);

    // GET /repos/{o}/{r}
    if (method === 'GET' && tail.length === 0) return json(200, repoJson(repo));
    // PATCH /repos/{o}/{r}
    if (method === 'PATCH' && tail.length === 0) {
      const data = (body ?? {}) as Record<string, unknown>;
      if (typeof data.description === 'string') repo.description = data.description;
      return json(200, repoJson(repo));
    }
    // DELETE /repos/{o}/{r}
    if (method === 'DELETE' && tail.length === 0) {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: '' };
    }

    // POST /repos/{o}/{r}/git/refs
    if (method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      const data = (body ?? {}) as Record<string, unknown>;
      const ref = typeof data.ref === 'string' ? data.ref : '';
      const sha = typeof data.sha === 'string' ? data.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha)) return unprocessable('ref and sha are required');
      if (repo.refs.has(ref)) return unprocessable(`Reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha } });
    }
    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (method === 'GET' && tail.length === 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads') {
      const ref = `refs/heads/${tail[3]!}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound('Reference does not exist');
      return json(200, { ref, object: { sha } });
    }

    // GET /repos/{o}/{r}/branches
    if (method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha } }));
      branches.sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, branches);
    }
    // GET /repos/{o}/{r}/branches/{branch}
    if (method === 'GET' && tail.length === 2 && tail[0] === 'branches') {
      const sha = store.branchTip(repo, tail[1]!);
      if (sha === undefined) return notFound('Branch not found');
      return json(200, { name: tail[1]!, commit: { sha } });
    }

    // GET /repos/{o}/{r}/commits
    if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === undefined) return notFound('Commit not found');
      return json(200, branchCommits(repo, tip));
    }

    // contents: /repos/{o}/{r}/contents/{path...}
    if (tail.length >= 2 && tail[0] === 'contents') {
      const path = tail.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (tip === undefined) return notFound('Not Found');
        const files = store.flattenTree(repo, tip);
        const entry = files.get(path);
        if (entry !== undefined) {
          const object = repo.objects.get(entry.oid);
          const content = object === undefined ? Buffer.alloc(0) : object.data;
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: path.split('/').pop() ?? path,
            path,
            content: content.toString('base64'),
            sha: entry.oid,
          });
        }
        // Directory listing: entries whose path is under `path/`, or the root.
        const prefix = path === '' ? '' : `${path}/`;
        const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
        for (const [filePath, file] of files) {
          if (prefix !== '' && !filePath.startsWith(prefix)) continue;
          const rest = prefix === '' ? filePath : filePath.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) {
            children.set(rest, { type: 'file', name: rest, path: filePath, sha: file.oid });
          } else {
            const dir = rest.slice(0, slash);
            if (!children.has(dir)) {
              // The tree object id for the directory.
              const dirPath = prefix === '' ? dir : `${prefix}${dir}`;
              children.set(dir, { type: 'dir', name: dir, path: dirPath, sha: directorySha(repo, tip, dirPath) });
            }
          }
        }
        if (children.size === 0) return notFound('Not Found');
        return json(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
      }
      if (method === 'PUT') {
        const data = (body ?? {}) as Record<string, unknown>;
        const contentB64 = typeof data.content === 'string' ? data.content : '';
        const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
        const messageText = typeof data.message === 'string' ? data.message : 'Update file';
        const sha = typeof data.sha === 'string' ? data.sha : undefined;
        if (contentB64 === '') return unprocessable('content is required');
        const content = Buffer.from(contentB64, 'base64');
        // Create the branch from the default tip when it does not exist yet.
        if (store.branchTip(repo, branch) === undefined) {
          const defaultTip = store.branchTip(repo, repo.defaultBranch);
          if (defaultTip === undefined) {
            const created = store.commitFile(repo, branch, path, content, messageText);
            return json(201, { content: { sha: created.contentSha, encoding: 'base64' }, commit: { sha: created.commitSha } });
          }
          repo.refs.set(`refs/heads/${branch}`, defaultTip);
        }
        const tip = store.branchTip(repo, branch)!;
        const current = store.flattenTree(repo, tip).get(path);
        if (sha !== undefined && current?.oid !== sha) return message(409, 'sha does not match the current file');
        const isCreate = current === undefined;
        const result = store.commitFile(repo, branch, path, content, messageText);
        return json(isCreate ? 201 : 200, { content: { sha: result.contentSha, encoding: 'base64' }, commit: { sha: result.commitSha } });
      }
      if (method === 'DELETE') {
        const data = (body ?? {}) as Record<string, unknown>;
        const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
        const messageText = typeof data.message === 'string' ? data.message : 'Delete file';
        const sha = typeof data.sha === 'string' ? data.sha : undefined;
        const tip = store.branchTip(repo, branch);
        if (tip === undefined) return notFound('Not Found');
        const current = store.flattenTree(repo, tip).get(path);
        if (current === undefined) return notFound('Not Found');
        if (sha !== undefined && current.oid !== sha) return message(409, 'sha does not match the current file');
        const result = store.commitFile(repo, branch, path, null, messageText);
        return json(200, { commit: { sha: result.commitSha } });
      }
    }

    // POST /repos/{o}/{r}/labels
    if (method === 'POST' && tail.length === 1 && tail[0] === 'labels') {
      const data = (body ?? {}) as Record<string, unknown>;
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') return unprocessable('name is required');
      const color = typeof data.color === 'string' ? data.color : '000000';
      repo.labels.set(name, { name, color });
      return json(201, { name, color });
    }

    // POST /repos/{o}/{r}/issues
    if (method === 'POST' && tail.length === 1 && tail[0] === 'issues') {
      const data = (body ?? {}) as Record<string, unknown>;
      const title = typeof data.title === 'string' ? data.title : '';
      if (title === '') return unprocessable('title is required');
      const labels = Array.isArray(data.labels) ? data.labels.filter((l): l is string => typeof l === 'string') : [];
      const unknown = labels.filter((label) => !repo.labels.has(label));
      if (unknown.length > 0) return unprocessable(`Label ${unknown[0]!} does not exist`);
      const issue = store.createIssue(repo, title, typeof data.body === 'string' ? data.body : '', labels);
      return json(201, issueJson(repo, issue));
    }
    // GET /repos/{o}/{r}/issues
    if (method === 'GET' && tail.length === 1 && tail[0] === 'issues') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const { headers, slice } = pagination(issues.length, perPage, page, `${ctx.origin}/api/v3/repos/${owner}/${repoName}/issues`);
      return json(200, issues.slice(...slice).map((issue) => issueJson(repo, issue)), headers);
    }
    // GET /repos/{o}/{r}/issues/{n}
    if (method === 'GET' && tail.length === 2 && tail[0] === 'issues') {
      const issue = repo.issues.find((item) => item.number === Number.parseInt(tail[1]!, 10));
      if (issue === undefined) return notFound('Issue not found');
      return json(200, issueJson(repo, issue));
    }
    // PATCH /repos/{o}/{r}/issues/{n}
    if (method === 'PATCH' && tail.length === 2 && tail[0] === 'issues') {
      const issue = repo.issues.find((item) => item.number === Number.parseInt(tail[1]!, 10));
      if (issue === undefined) return notFound('Issue not found');
      const data = (body ?? {}) as Record<string, unknown>;
      if (typeof data.state === 'string' && (data.state === 'open' || data.state === 'closed')) issue.state = data.state;
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      issue.updatedAt = timestampOf(store.nextSeq());
      return json(200, issueJson(repo, issue));
    }
    // POST /repos/{o}/{r}/issues/{n}/comments
    if (method === 'POST' && tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments') {
      const issue = repo.issues.find((item) => item.number === Number.parseInt(tail[1]!, 10));
      if (issue === undefined) return notFound('Issue not found');
      const data = (body ?? {}) as Record<string, unknown>;
      const comment = store.createComment(issue, typeof data.body === 'string' ? data.body : '');
      return json(201, { id: comment.id, body: comment.body });
    }
    // GET /repos/{o}/{r}/issues/{n}/comments
    if (method === 'GET' && tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments') {
      const issue = repo.issues.find((item) => item.number === Number.parseInt(tail[1]!, 10));
      if (issue === undefined) return notFound('Issue not found');
      return json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
    }

    // POST /repos/{o}/{r}/pulls
    if (method === 'POST' && tail.length === 1 && tail[0] === 'pulls') {
      const data = (body ?? {}) as Record<string, unknown>;
      const title = typeof data.title === 'string' ? data.title : '';
      const head = typeof data.head === 'string' ? data.head : '';
      const base = typeof data.base === 'string' ? data.base : repo.defaultBranch;
      if (title === '' || head === '') return unprocessable('title and head are required');
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === undefined || baseSha === undefined) return unprocessable('head or base branch does not exist');
      const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
      if (existing !== undefined) return unprocessable('A pull request already exists for this head branch');
      const pull = store.createPull(repo, title, typeof data.body === 'string' ? data.body : '', head, base, headSha, baseSha);
      return json(201, pullJson(repo, pull));
    }
    // GET /repos/{o}/{r}/pulls
    if (method === 'GET' && tail.length === 1 && tail[0] === 'pulls') {
      const state = query.get('state') ?? 'open';
      const pulls = state === 'all' ? [...repo.pulls] : repo.pulls.filter((pull) => pull.state === state);
      const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const { headers, slice } = pagination(pulls.length, perPage, page, `${ctx.origin}/api/v3/repos/${owner}/${repoName}/pulls`);
      return json(200, pulls.slice(...slice).map((pull) => pullJson(repo, pull)), headers);
    }
    // GET /repos/{o}/{r}/pulls/{n}
    if (method === 'GET' && tail.length === 2 && tail[0] === 'pulls') {
      const pull = repo.pulls.find((item) => item.number === Number.parseInt(tail[1]!, 10));
      if (pull === undefined) return notFound('Pull request not found');
      return json(200, pullJson(repo, pull));
    }
    // GET /repos/{o}/{r}/pulls/{n}/files
    if (method === 'GET' && tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'files') {
      const pull = repo.pulls.find((item) => item.number === Number.parseInt(tail[1]!, 10));
      if (pull === undefined) return notFound('Pull request not found');
      return json(200, pullFiles(store, repo, pull));
    }
    // PUT /repos/{o}/{r}/pulls/{n}/merge
    if (method === 'PUT' && tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'merge') {
      const pull = repo.pulls.find((item) => item.number === Number.parseInt(tail[1]!, 10));
      if (pull === undefined) return notFound('Pull request not found');
      if (pull.state !== 'open') return message(405, 'Pull request is not open');
      const data = (body ?? {}) as Record<string, unknown>;
      if (typeof data.merge_method === 'string' && data.merge_method !== 'squash') return unprocessable('merge_method must be squash');
      const merged = trySquashMerge(store, repo, pull);
      if (merged === null) return message(405, 'Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = merged.sha;
      pull.mergedAt = timestampOf(store.nextSeq());
      pull.updatedAt = pull.mergedAt;
      return json(200, { sha: merged.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
    }
  }

  return notFound();
}

/** The tree oid of a directory inside a commit's tree, or the zero oid. */
function directorySha(repo: Repo, commitOid: string, dirPath: string): string {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return '0'.repeat(40);
  let current = parseCommit(commit.data).tree;
  for (const part of dirPath.split('/')) {
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return '0'.repeat(40);
    const entry = parseTree(tree.data).find((item) => item.name === part && item.mode === '40000');
    if (entry === undefined) return '0'.repeat(40);
    current = entry.oid;
  }
  return current;
}
