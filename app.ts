// The forge's HTTP server: auth, request ids, and the wiring between the
// transport (Node's http server) and the four surfaces — git smart HTTP,
// REST v3, GraphQL v4, MCP. Written from the suite's own client behavior,
// not copied from any other project.
//
// Auth: every route except /healthz requires `Authorization: Bearer <token>`
// matching $MAKEFUN_SHOP_TOKEN when that variable is set (the trial sets it).
// When it is unset (local development), any token is accepted so the forge
// can be exercised by hand. A missing or wrong token answers 401 JSON.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGit, isGitPath } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function isAuthorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === SHOP_TOKEN;
}

export function createApp(): http.Server {
  const store = new Store();
  let requestCounter = 0;
  const server = http.createServer((req, res) => {
    const requestId = `req-${++requestCounter}`;
    const send = (status: number, contentType: string, body: Buffer | string): void => {
      const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      res.writeHead(status, {
        'Content-Type': contentType,
        'X-GitHub-Request-Id': requestId,
        'Content-Length': payload.length,
      });
      res.end(payload);
    };
    const sendJson = (status: number, value: unknown, extraHeaders: Record<string, string> = {}): void => {
      const payload = value === null ? Buffer.alloc(0) : Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        'X-GitHub-Request-Id': requestId,
        'Content-Length': payload.length,
        ...extraHeaders,
      };
      res.writeHead(status, headers);
      res.end(payload);
    };
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && pathname === '/healthz') {
          send(200, 'text/plain; charset=utf-8', 'ok');
          return;
        }

        if (!isAuthorized(req)) {
          sendJson(401, { message: 'Bad credentials' });
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks);

        if (pathname.startsWith('/api/v3')) {
          let body: unknown;
          if (rawBody.length > 0) {
            try {
              body = JSON.parse(rawBody.toString('utf8')) as unknown;
            } catch {
              sendJson(400, { message: 'Problems parsing JSON' });
              return;
            }
          }
          const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
          const result = handleRest({ store, origin }, method, pathname, url.searchParams, body);
          const headers: Record<string, string> = {
            'Content-Type': 'application/json; charset=utf-8',
            'X-GitHub-Request-Id': requestId,
            ...(result.headers ?? {}),
          };
          const payload = Buffer.from(result.body, 'utf8');
          headers['Content-Length'] = String(payload.length);
          res.writeHead(result.status, headers);
          res.end(payload);
          return;
        }

        if (pathname === '/api/graphql' && method === 'POST') {
          let body: unknown;
          try {
            body = JSON.parse(rawBody.toString('utf8')) as unknown;
          } catch {
            sendJson(400, { message: 'Problems parsing JSON' });
            return;
          }
          const result = handleGraphQL(store, body);
          send(result.status, 'application/json; charset=utf-8', result.body);
          return;
        }

        if (pathname === '/mcp' && method === 'POST') {
          const result = handleMcp(store, rawBody);
          if (result.status === 202) {
            send(202, 'application/json; charset=utf-8', '');
            return;
          }
          send(result.status, 'application/json; charset=utf-8', result.body);
          return;
        }

        if (isGitPath(pathname)) {
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value[0] : value;
          const result = handleGit(store, method, pathname, url.searchParams, headers, rawBody);
          send(result.status, result.contentType, result.body);
          return;
        }

        sendJson(404, { message: 'Not Found' });
      } catch (err) {
        // Never let one bad request kill the server: answer 500 and stay up.
        try {
          sendJson(500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.end();
          } catch {
            // The connection is already gone; nothing more to do.
          }
        }
      }
    })();
  });
  return server;
}
