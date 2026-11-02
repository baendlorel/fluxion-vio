# Fluxion Vio

[![npm version](https://img.shields.io/npm/v/fluxion-vio.svg)](https://www.npmjs.org/package/fluxion-vio)
[![npm downloads](https://img.shields.io/npm/dm/fluxion-vio.svg)](https://www.npmjs.org/package/fluxion-vio)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<p align="center">
  <img src="assets/fluxion.png" width="240px" alt="Fluxion Vio logo" />
</p>

**Fluxion Vio** is a branch of [Fluxion v0.20.4](https://github.com/baendlorel/fluxion): a filesystem-routing HTTP server with PHP-style hot reload. The file path is the URL path — edit a file under `dir`, and the next request serves the new code. No build step, no route table, no watcher, no restart.

It is meant for **modest traffic** behind a trusted network: internal tools, admin panels, small APIs, webhooks, prototypes. It is **not** a security boundary and not built for high concurrency — for anything public, put a reverse proxy in front.

## Install

```bash
pnpm add fluxion-vio
```

`esbuild` ships as a dependency and compiles every file under `dir` on load, so **you do not need `tsx` for your routes**: the entry point may be plain JavaScript while everything under `dir` stays TypeScript.

A TypeScript entry point is _not_ compiled by Fluxion — run it with Node ≥ 22.18's built-in type stripping, or with `tsx`.

## Quick start

`server.js`:

```js
import { fluxion } from 'fluxion-vio';

await fluxion({ dir: './dynamic', host: '127.0.0.1', port: 3000 });
```

`dynamic/hello.ts`:

```ts
import { defineFluxionModule } from 'fluxion-vio';

export default defineFluxionModule(async (req) => {
  return { message: 'hello vio', path: req.url.pathname };
});
```

```bash
node server.js
curl http://127.0.0.1:3000/hello.ts
# {"message":"hello vio","path":"/hello.ts"}
```

## Routing

- Files matching `apiInclude` (default `**/*.ts`) are API handlers.
- Files matching `staticInclude` (default `**/*`) are static resources, `GET`/`HEAD` only.
- Files matching `exclude` are never served.
- The file extension is part of the route.

| File                      | Route              | Type        |
| ------------------------- | ------------------ | ----------- |
| `dynamic/hello.ts`        | `/hello.ts`        | API handler |
| `dynamic/user/profile.ts` | `/user/profile.ts` | API handler |
| `dynamic/index.html`      | `/index.html`      | Static file |

## API handlers

Handlers must be created with `defineFluxionModule()`; a bare exported function is rejected.

```ts
import { defineFluxionModule, defineFluxionMiddleware } from 'fluxion-vio';

const auth = defineFluxionMiddleware(async (req, cx, rawReq, rawRes) => {
  if (!req.headers.authorization) {
    rawRes.statusCode = 401;
    rawRes.end('Unauthorized');
    return; // the handler is not called
  }
  req.meta.user = { id: 1 };
});

export default defineFluxionModule({
  middlewares: [auth],
  methods: ['GET', 'POST'], // omit to accept every method
  handlerTimeoutMs: 10_000, // override options.handlerTimeoutMs
  handler: async (req) => ({ user: req.meta.user }),
  disposer: async () => {
    // runs after the response for this request has been sent
  },
});
```

Handler signature: `handler(req, cx, rawReq, rawRes)`

| Argument | Contents                                                                                      |
| -------- | --------------------------------------------------------------------------------------------- |
| `req`    | `{ method, ip, url, query, body, headers, cookie, meta }` — `meta` is shared with middleware. |
| `cx`     | `{ logger }`                                                                                  |
| `rawReq` | Node.js `http.IncomingMessage`                                                                |
| `rawRes` | Node.js `http.ServerResponse`                                                                 |

Return a value to send `200` + JSON, or write to `rawRes` yourself. If `rawRes.writableEnded` is true, nothing else is sent.

## Request body

Parsed before the handler runs, except for `GET`/`HEAD`:

- `application/json` → the object; primitives become `{ value }`; invalid JSON becomes `{ raw }`.
- Form data → key/value fields. `text/*` → `{ raw }`. Binary → `{}` (size check only).
- Bodies over `maxRequestBytes` (default 8 MB) get `413`.

## Middleware

Run sequentially before the handler, each with `middlewareTimeoutMs` (default 3 s). Side effects on `req` are visible to the next middleware and the handler. Write to `rawRes` and return to short-circuit.

## Logging

Logs are JSON Lines by default: one JSON object per line on stdout, with `timestamp`, `level` and `event` fields.

```ts
cx.logger.info('request'); // {"timestamp":"…","level":"INFO","event":"request"}
cx.logger.warn({ event: 'RateLimited', ip: req.ip }); // {"timestamp":"…","level":"WARN","event":"RateLimited","ip":"…"}
```

- A primitive payload (`string`, number, boolean, `null`) becomes `event`.
- An object payload is merged after the defaults, so your own fields can override `timestamp`, `level` or `event`.
- An `Error` value anywhere in the payload is serialized as `message` + newline + `stack` (plain `JSON.stringify` would give `{}`). Use the exported `formatError(e)` to get the same string yourself.

There is no built-in one-line mode. To get a human-readable format, pass your own logger function:

```ts
import { fluxion, defineFluxionLogger } from 'fluxion-vio';

const oneLine = defineFluxionLogger(({ timestamp, level, event, ...fields }) => {
  const rest = Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  console.log(`[${timestamp}] ${level} ${String(event ?? '')}${rest}`);
});

await fluxion({ dir: './dynamic', host: '127.0.0.1', port: 3000, logger: oneLine });
```

Setting `FLUXION_INSTANCE_LOG=/path/to/file.log` additionally writes the same JSON lines to that file.

## HTTP exceptions

```ts
import { defineFluxionModule, NotFoundException } from 'fluxion-vio';

export default defineFluxionModule(() => {
  throw new NotFoundException('nothing here');
});
```

`BadRequest` 400 · `Unauthorized` 401 · `Forbidden` 403 · `NotFound` 404 · `MethodNotAllowed` 405 · `NotAcceptable` 406 · `RequestTimeout` 408 · `Conflict` 409 · `Gone` 410 · `PayloadTooLarge` 413 · `UnsupportedMediaType` 415 · `UnprocessableEntity` 422 · `TooManyRequests` 429 · `InternalServerError` 500 · `NotImplemented` 501 · `BadGateway` 502 · `ServiceUnavailable` 503 · `GatewayTimeout` 504

(each is exported as `<Name>Exception`). Uncaught errors return a generic `500`; details are never sent to the client.

## Hot reload

Every request resolves its file from disk, so there is no route table to refresh and no watcher:

- Modules are loaded on demand and remembered together with the `mtime` and `size` of the file and of every file it imports from `dir`.
- On the next request those are compared. If any one differs, the whole chain is dropped and re-evaluated; otherwise the loaded module is reused without reading anything.
- Content is never compared, so an edit that keeps both `mtime` and `size` goes unnoticed.
- Packages from `node_modules` and files outside `dir` go through Node's own `require` and stay cached. Files outside `dir` are therefore **not** compiled: a TS helper placed there relies on Node's built-in type stripping (no `enum`, `namespace`, or decorators).
- A deleted file means `404`; recreating it serves it immediately. A new file is loaded only when a request asks for it or a changed file starts importing it.

Module-level state survives between requests until a reload resets it — keep handlers stateless.

## Memory-triggered restart

Long-running processes that reload edited files keep growing: V8's compilation cache and old module instances are never handed back. Set `restartMemoryMB` to restart the process in place once its RSS crosses that many megabytes:

```ts
await fluxion({ dir: './dynamic', host: '127.0.0.1', port: 3000, restartMemoryMB: 512 });
```

- RSS is first sampled 5 seconds after `fluxion()` returns — long enough for your own startup work (database connections, cache warm-up) to settle — and then every 10 seconds. The first sample above the threshold wins.
- The server stops accepting connections and closes idle ones, then the file log is flushed. In-flight requests get up to 5 seconds to finish.
- The entry point is re-executed with the same argv and environment via `process.execve`, **keeping the PID** — pm2, systemd or Docker see no restart. Expect a gap of a few dozen milliseconds.
- If `execve` fails, the process logs `RestartFailed` and exits with code 1 so a supervisor can pick it up.

Requires Node.js ≥ 22.15 on Linux or macOS. Elsewhere the option is ignored — the server starts normally and logs a `RestartDisabled` warning once. Leave it unset (`false`) unless you need it.

## Options

```ts
interface FluxionOptions {
  dir: string; // route directory, created if missing
  host: string;
  port: number;

  handlerTimeoutMs?: number; // 5000
  middlewareTimeoutMs?: number; // 3000
  staticResourceTimeoutMs?: number; // 180000

  apiInclude?: string[]; // ['**/*.ts']
  staticInclude?: string[]; // ['**/*']
  exclude?: string[]; // node_modules, .git, dist, ...

  maxRequestBytes?: number; // 8_000_000
  logger?: 'json-line' | ((entry) => void); // 'json-line'
  target?: string | string[]; // esbuild target, default 'node<major>'
  https?: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer | Array<string | Buffer> };
  csp?: string | false; // "default-src 'self'"; false omits the header
  restartMemoryMB?: number | false; // restart in place above this RSS; false (default) disables
}
```

`https.key`/`cert`/`ca` accept PEM content or a path relative to the current working directory. For small services, terminating TLS at a reverse proxy is usually simpler.

## Security

Every response gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, and a CSP header; path traversal outside `dir` is rejected. Beyond that Vio provides no authentication, authorization, CSRF protection, rate limiting, or sandboxing — handlers run with full Node.js privileges. Bind to a private interface, keep secrets out of `dir` (it is web-served by default), and never expose the server directly to the internet.

## Deployment

Single process, no supervisor. Use pm2, systemd, Docker, or a similar manager:

```bash
pm2 start "node server.js" --name fluxion-vio-app
```

Need clustering? Run several instances behind a proxy, or use upstream Fluxion. To cap memory growth, see [Memory-triggered restart](#memory-triggered-restart) — it restarts in place, so the manager never notices.

## Migrating from Fluxion

The APIs are identical; rename the package and import specifier, and replace `launchDaemon` with a process manager.

## Development

```bash
pnpm build   # bundle with tsdown
pnpm test    # vitest
pnpm lint    # oxlint
```
