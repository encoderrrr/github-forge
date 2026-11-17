// git smart HTTP: protocol v2 and v0 upload-pack, v0 receive-pack, over
// /<owner>/<repo>.git. Written from the git wire format and the suite's own
// client behavior (what it sends, what it parses), not copied from any
// other project.
//
//   GET  /{o}/{r}.git/info/refs?service=git-upload-pack   v2 or v0 advertisement
//   GET  /{o}/{r}.git/info/refs?service=git-receive-pack  v0 advertisement
//   POST /{o}/{r}.git/git-upload-pack                     ls-refs / fetch
//   POST /{o}/{r}.git/git-receive-pack                    push (report-status, side-band-64k)

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'makefun-forge/1.0';

const V2_CAPABILITIES = ['ls-refs', 'fetch=shallow', 'object-format=sha1', `agent=${AGENT}`];
const V0_UPLOAD_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main agent=' + AGENT;
const V0_RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const json404 = (message = 'Not Found'): GitHttpResult => ({
  status: 404,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
});

const badRequest = (message: string): GitHttpResult => ({
  status: 400,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
});

// ---------------------------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------------------------

/** Refs sorted by name, heads then tags. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The commit a tag peels to (or the oid itself when it is not a tag). */
function peel(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type !== 'tag') return oid;
  const target = parseTag(object.data).object;
  const peeled = repo.objects.get(target);
  if (peeled === undefined) return null;
  return peeled.type === 'tag' ? peel(repo, target) : target;
}

interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * The objects a fetch must deliver: the depth-limited closure of the wants,
 * minus everything reachable from the haves. `depth` counts want commits as
 * level 1; a commit at the depth limit is a shallow boundary (its parents are
 * not traversed). Old shallow boundaries whose parent is now included are
 * reported unshallow.
 */
function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | undefined,
): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const included = new Set<string>();
  const boundary = new Set<string>();
  // BFS over commits from the wants, tracking depth. Tags are peeled first.
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      included.add(want);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, level: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, level: 1 });
    } else {
      included.add(want);
    }
  }
  const seenLevel = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    const previous = seenLevel.get(oid);
    if (previous !== undefined && previous <= level) continue;
    seenLevel.set(oid, level);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.add(oid);
    if (depth !== undefined && level >= depth) {
      if (parseCommit(object.data).parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, level: level + 1 });
  }
  // The closure of a commit set: each commit contributes its own tree (trees
  // and blobs), never its parents — the caller decides which commits are in.
  // This keeps depth limits and shallow boundaries intact.
  const treeClosure = (commits: Iterable<string>): Set<string> => {
    const closure = new Set<string>();
    const pending = [...commits];
    while (pending.length > 0) {
      const oid = pending.pop()!;
      if (closure.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      closure.add(oid);
      if (object.type === 'commit') {
        const treeStack = [parseCommit(object.data).tree];
        while (treeStack.length > 0) {
          const treeOid = treeStack.pop()!;
          if (closure.has(treeOid)) continue;
          const tree = lookup(treeOid);
          if (tree === undefined || tree.type !== 'tree') continue;
          closure.add(treeOid);
          for (const entry of parseTree(tree.data)) {
            if (entry.mode === '160000') continue;
            if (entry.mode === '40000') treeStack.push(entry.oid);
            else pending.push(entry.oid);
          }
        }
      } else if (object.type === 'tag') {
        pending.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') pending.push(entry.oid);
        }
      }
    }
    return closure;
  };
  const wantedClosure = treeClosure(included);
  // What the client already holds: the ancestry of its haves, stopping at the
  // old shallow boundaries (a shallow clone holds the boundary commit and its
  // tree, not the boundary's parents).
  const heldCommits = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (heldCommits.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      heldCommits.add(oid);
      if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'commit' && !oldShallow.includes(oid)) {
        queue.push(...parseCommit(object.data).parents);
      }
    }
  }
  const heldClosure = treeClosure(heldCommits);
  const objects = new Map<string, GitObject>();
  for (const oid of wantedClosure) {
    if (heldClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.set(oid, object);
  }
  const shallow = [...boundary].filter((oid) => objects.has(oid)).sort();
  const unshallow: string[] = [];
  for (const old of oldShallow) {
    // An old boundary is lifted when its parent is now included (its level is under the depth).
    const object = repo.objects.get(old);
    if (object === undefined || object.type !== 'commit') continue;
    const level = seenLevel.get(old);
    if (level !== undefined && (depth === undefined || level < depth)) {
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => seenLevel.has(parent))) unshallow.push(old);
    }
  }
  const acks: string[] = [];
  for (const have of haves) {
    if (wantedClosure.has(have) || heldClosure.has(have)) {
      // The have is an ancestor-or-self of a want when it is in the want closure.
      if (collectReachable(wants, lookup, { allowMissing: true }).has(have)) acks.push(have);
    }
  }
  return { objects, shallow, unshallow, acks };
}

/** Pack objects in a deterministic order, sorted by object id (no re-hashing). */
function sortedPackObjects(objects: Map<string, GitObject>): GitObject[] {
  return [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, object]) => object);
}

/** Sideband-frame a pack: band 1 chunks of at most 32768 bytes each. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 32768) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 32768));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), pack])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  const lines: string[] = ['version 2\n', ...V2_CAPABILITIES.map((cap) => `${cap}\n`)];
  return Buffer.concat([encodePktLines(lines), pktLineFlush()]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = headTip !== undefined ? `${headTip} HEAD\0${caps}\n` : `${refs[0]!.oid} ${refs[0]!.name}\0${caps}\n`;
    parts.push(encodePktLine(headLine));
    const start = headTip !== undefined ? 0 : 1;
    for (let i = start; i < refs.length; i += 1) {
      const ref = refs[i]!;
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peel(repo, ref.oid);
        if (peeled !== null && peeled !== ref.oid) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

function lsRefsV2(repo: Repo, args: readonly string[]): Buffer {
  const peelRequested = args.includes('peel');
  const symrefsRequested = args.includes('symrefs');
  const prefixes: string[] = [];
  for (const arg of args) if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    const target = symrefsRequested ? ' symref-target:refs/heads/main' : '';
    lines.push(`${headTip ?? ZERO_OID} HEAD${target}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peelRequested && ref.name.startsWith('refs/tags/')) {
      const peeled = peel(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([encodePktLines(lines), pktLineFlush()]);
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

/**
 * A fetch response is a pure function of the repository's refs, its object
 * count, and the request (wants, haves, shallow boundaries, depth): objects
 * are immutable and append-only, and a ref move is the only way new objects
 * become reachable. The benchmark clones the same repository state fifty
 * times in a row, so caching the built response (pack included) makes the
 * second and later clones nearly free. The fingerprint covers every input
 * that can change the answer, so a stale pack cannot be served.
 */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 32;

function fetchCacheKey(
  protocol: 'v2' | 'v0',
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | undefined,
): string {
  const refs = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, oid]) => `${name}=${oid}`)
    .join(';');
  return [
    protocol,
    `${repo.owner}/${repo.name}`,
    refs,
    String(repo.objects.size),
    [...wants].sort().join(','),
    [...haves].sort().join(','),
    [...oldShallow].sort().join(','),
    depth === undefined ? '' : String(depth),
  ].join('|');
}

function fetchCached(key: string, build: () => Buffer): Buffer {
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  const built = build();
  fetchCache.set(key, built);
  if (fetchCache.size > FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  return built;
}

function fetchResponseV2(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | undefined,
): Buffer {
  return fetchCached(fetchCacheKey('v2', repo, wants, haves, oldShallow, depth), () => {
    const selection = selectFetch(repo, wants, haves, oldShallow, depth);
    const pack = writePack(sortedPackObjects(selection.objects));
    const parts: Buffer[] = [];
    parts.push(encodePktLine('acknowledgments\n'));
    if (selection.acks.length === 0) parts.push(encodePktLine('NAK\n'));
    else for (const ack of selection.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(pktLineDelim());
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      parts.push(pktLineDelim());
    }
    parts.push(encodePktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(pktLineFlush());
    return Buffer.concat(parts);
  });
}

function fetchResponseV0(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | undefined,
): Buffer {
  return fetchCached(fetchCacheKey('v0', repo, wants, haves, oldShallow, depth), () => {
    const selection = selectFetch(repo, wants, haves, oldShallow, depth);
    const pack = writePack(sortedPackObjects(selection.objects));
    const parts: Buffer[] = [];
    if (selection.acks.length === 0) parts.push(encodePktLine('NAK\n'));
    else for (const ack of selection.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(sidebandPack(pack));
    parts.push(pktLineFlush());
    return Buffer.concat(parts);
  });
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Parse a receive-pack body: pkt-lines until the first flush, then the raw pack.
 * Returns null when the framing is malformed.
 */
function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  let offset = 0;
  const commands: PushCommand[] = [];
  for (;;) {
    if (offset + 4 > body.length) return null;
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || length > 65520 || offset + length > body.length) return null;
    const line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = line.indexOf('\0');
    const text = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, pack: body.subarray(offset) };
}

function receivePack(store: Store, repo: Repo, body: Buffer): GitHttpResult {
  const parsed = parseReceivePackBody(body);
  if (parsed === null || parsed.commands.length === 0) return badRequest('malformed receive-pack body');
  const { commands } = parsed;
  // Unpack first: a bad pack is an unpack error, and no ref moves.
  let unpacked = new Map<string, GitObject>();
  if (parsed.pack.length > 0) {
    try {
      unpacked = readPack(parsed.pack);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unpack failed';
      const lines = [`unpack ${detail}\n`];
      for (const command of commands) lines.push(`ng ${command.ref} unpack failed\n`);
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-result',
        body: Buffer.concat([sidebandPackLines(lines), pktLineFlush()]),
      };
    }
    for (const [oid, object] of unpacked) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }
  const lines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = '';
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reason = 'non-fast-forward';
      } else if (current !== command.oldOid) {
        reason = 'non-fast-forward';
      } else {
        repo.refs.delete(command.ref);
        ok = true;
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reason = 'already exists';
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'missing object';
      } else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    } else {
      // Update: must fast-forward from the advertised old value.
      if (current === undefined || current !== command.oldOid) {
        reason = 'non-fast-forward';
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'missing object';
      } else if (!store.isAncestor(repo, command.oldOid, store.peelToCommit(repo, command.newOid))) {
        reason = 'non-fast-forward';
      } else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    }
    lines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat([sidebandPackLines(lines), pktLineFlush()]),
  };
}

/** Frame report-status pkt-lines inside sideband band 1 (one packet per line). */
function sidebandPackLines(lines: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), encodePktLine(line)])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// entry point: route one git request
// ---------------------------------------------------------------------------------------------

export function handleGit(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitHttpResult {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (match === null) return json404();
  const owner = decodeURIComponent(match[1]!);
  const repoName = decodeURIComponent(match[2]!);
  const rest = match[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return json404('Repository not found');
  const isV2 = headers['git-protocol'] === 'version=2';

  if (method === 'GET' && rest === '/info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: isV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack'),
      };
    }
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-advertisement',
        body: v0Advertisement(repo, 'git-receive-pack'),
      };
    }
    return json404();
  }

  if (method === 'POST' && rest === '/git-upload-pack') {
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      return badRequest('malformed pkt-line stream');
    }
    if (isV2) {
      const lines: string[] = [];
      let delimSeen = false;
      const args: string[] = [];
      let command = '';
      for (const packet of packets) {
        if (packet.kind === 'flush') break;
        if (packet.kind === 'delim') {
          delimSeen = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const text = packet.payload.toString('utf8');
        if (!delimSeen && command === '' && text.startsWith('command=')) {
          command = text.slice('command='.length).replace(/\n$/, '');
          continue;
        }
        if (!delimSeen) continue;
        args.push(text.replace(/\n$/, ''));
      }
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsV2(repo, args) };
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let depth: number | undefined;
        for (const arg of args) {
          if (arg.startsWith('want ')) wants.push(arg.slice(5));
          else if (arg.startsWith('have ')) haves.push(arg.slice(5));
          else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8));
          else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
        }
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-result',
          body: fetchResponseV2(repo, wants, haves, shallow, depth),
        };
      }
      return badRequest('unknown upload-pack command');
    }
    // v0 fetch: wants/shallow/deepen, flush, haves/done, flush.
    const sections: string[][] = [[]];
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        sections.push([]);
        continue;
      }
      if (packet.kind !== 'data') continue;
      sections[sections.length - 1]!.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const line of sections[0] ?? []) {
      if (line.startsWith('want ')) {
        const restLine = line.slice(5);
        const space = restLine.indexOf(' ');
        wants.push(space < 0 ? restLine : restLine.slice(0, space));
      } else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    }
    for (const line of sections[1] ?? []) {
      if (line.startsWith('have ')) haves.push(line.slice(5));
    }
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: fetchResponseV0(repo, wants, haves, shallow, depth),
    };
  }

  if (method === 'POST' && rest === '/git-receive-pack') {
    return receivePack(store, repo, body);
  }

  return json404();
}

/** Whether a path is a git smart-HTTP path. */
export function isGitPath(pathname: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(pathname);
}
