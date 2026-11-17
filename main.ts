// Boot handshake between this forge and the trial env.
//
// The forge itself lives in app.ts (createApp): git smart HTTP, REST v3,
// GraphQL and MCP. This file only runs the lifecycle the env expects:
//
//   1. Read MAKEFUN_ENV_URL, the env's origin. With no env there is
//      nothing to register with, so exit at once.
//   2. Start the forge on an ephemeral port (listen(0) lets the kernel
//      pick one). Never 8080 — the env listens there.
//   3. POST {"port": <bound port>} to <env>/register so the suite knows
//      where to dial the forge.
//   4. Poll GET <env>/done until it answers {"done": true}, then close
//      the server and exit 0.
//
// GET /healthz is answered by app.ts itself (200 "ok"), so the suite can
// probe liveness from the moment we start listening. The env answers
// /done immediately with {"done": false} while the suite is still
// running, so step 4 is a poll loop, not one long-held request. A poll
// or register that fails — env still starting, a timeout, a stray
// status — is retried forever with a growing pause; the process never
// gives up and never exits before the env says done. The only way out
// early is a contract error from register (400/405), which retrying
// cannot fix.

import { createApp } from './app.ts';

// The env's origin, without a trailing slash. Empty means no env.
const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  console.error('[forge] MAKEFUN_ENV_URL is not set: no env to register with');
  process.exit(1);
}

// One request to the env may take at most this long before it is
// abandoned and retried.
const REQUEST_TIMEOUT_MS = 20_000;
// First pause between retries; it doubles after each failure, up to this cap.
const RETRY_FIRST_MS = 200;
const RETRY_CAP_MS = 4_000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A failure retrying cannot fix: register answered with a contract error.
class Fatal extends Error {}

/**
 * Run `step` until it returns a non-null value. A null return means "not
 * yet" (env not answering, still false, unexpected status); a thrown
 * Fatal means "never will be" and ends the process. Any other thrown
 * error — a dropped connection, a timeout, a malformed body — is treated
 * as "not yet" and retried after a pause that doubles from RETRY_FIRST_MS
 * up to RETRY_CAP_MS.
 */
async function retryForever<T>(step: () => Promise<T | null>): Promise<T> {
  let pauseMs = RETRY_FIRST_MS;
  for (;;) {
    try {
      const result = await step();
      if (result !== null) return result;
    } catch (err) {
      if (err instanceof Fatal) throw err;
      // Transient failure: fall through to the retry below.
    }
    await wait(pauseMs);
    pauseMs = Math.min(RETRY_CAP_MS, pauseMs * 2);
  }
}

/**
 * Tell the env which port the forge bound. 200 is the normal answer;
 * 409 means another entry already registered first, which is not this
 * process's problem to fix — either way the forge is reachable. 400 and
 * 405 are contract errors and end the program; anything else is retried.
 */
async function register(port: number): Promise<void> {
  await retryForever(async () => {
    const res = await fetch(`${envBase}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new Fatal(`register answered HTTP ${res.status}`);
    }
    return null;
  });
}

/** Poll GET /done until the env answers {"done": true}. */
async function waitUntilDone(): Promise<void> {
  await retryForever(async () => {
    const res = await fetch(`${envBase}/done`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true ? true : null;
  });
}

/** Start the forge, register it, wait for the env to finish, shut down. */
async function main(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, resolve);
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  console.log(`[forge] listening on port ${bound.port}`);

  await register(bound.port);
  console.log('[forge] registered with the env');

  await waitUntilDone();
  forge.close();
  console.log('[forge] env said done; shutting down');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[forge] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
