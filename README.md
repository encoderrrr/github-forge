# github-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/encoderrrr/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/encoderrrr/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge, written from scratch in TypeScript on Node's
built-ins only. One process serves four surfaces from a single in-memory
store: git smart HTTP (protocol v2 and v0 upload-pack, v0 receive-pack),
REST API v3, GraphQL v4, and MCP (Streamable HTTP, 2026-07-28 era).

[Make this entry on make.fun](https://make.fun/bounty/github-core-clone-01?ref=65vbztbk)

## Run

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it with the trial environment
(`$MAKEFUN_ENV_URL/register`), and long-polls `$MAKEFUN_ENV_URL/done`
until the trial ends. Without the environment variables set it serves on
port 3000 for local development.

## Layout

- `main.ts` — lifecycle: bind, register, serve, wait for done.
- `app.ts` — HTTP router, auth, request ids.
- `store.ts` — git object model, packfile and pkt-line codecs, the store.
- `git.ts` — smart HTTP (upload-pack v2/v0, receive-pack v0).
- `rest.ts` — REST API v3 (repos, refs, branches, commits, contents,
  labels, issues, comments, pull requests, squash merges).
- `graphql.ts` — GraphQL v4 (hand-written parser and executor).
- `mcp.ts` — MCP JSON-RPC over Streamable HTTP.

## License

MIT. See [LICENSE](LICENSE).
