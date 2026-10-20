# Fluxion Vio

[![npm version](https://img.shields.io/npm/v/fluxion-vio.svg)](https://www.npmjs.org/package/fluxion-vio)
[![npm downloads](https://img.shields.io/npm/dm/fluxion-vio.svg)](https://www.npmjs.org/package/fluxion-vio)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<p align="center">
  <img src="assets/fluxion.png" width="240px" alt="Fluxion Vio logo" />
</p>

**Fluxion Vio** is a branch of [Fluxion](https://github.com/baendlorel/fluxion) — a filesystem-routing dynamic HTTP server for Node.js with PHP-style hot reload.

Vio keeps the parts that make a small service quick to build and quick to ship, and drops the parts that only pay off at scale. It is meant for services with **modest traffic**, **low security requirements**, and **a deadline**: internal tools, admin panels, small APIs, webhooks, prototypes, and side services behind a trusted network.

- **Filesystem routing**: The file path IS the URL path. Drop a `.ts` file, and it becomes an API endpoint.
- **Lazy loading with hot reload**: Handlers are re-read from disk on every request. No build step, no route registration, no restart.
- **Static file serving**: Non-API files are served as static resources with automatic content-type detection.
- **Built-in middleware system**: Sequential middleware execution with timeout support.
- **HTTP exceptions**: Typed exception classes for clean error handling.
- **Small by design**: Single process, no clustering, no supervisor daemon, no built-in metadata endpoints.
- **Same API as Fluxion**: Handler, middleware, and option APIs are unchanged — migration is mostly an import rename.

## Is Vio right for you?

**Good fit**

- Internal tools and admin panels
- Small APIs and webhook receivers
- Prototypes, demos, and throwaway services
- Anything behind a trusted network or reverse proxy
- Teams that value time-to-production over operational depth

**Poor fit**

- High concurrency or heavy sustained traffic
- Multi-tenant or public-internet exposure to untrusted users
- Sensitive data — credentials, payment details, personal data
- Requirements for clustering, rate limiting, built-in authn/authz, or a supervised daemon

If you need those, use upstream Fluxion with a process manager, or a full-featured framework.

## Differences from Fluxion

Vio is a lean branch, not a rewrite:

| Area                  | Fluxion                    | Fluxion Vio                               |
| --------------------- | -------------------------- | ----------------------------------------- |
| Handler/middleware API | —                         | Identical                                 |
| Options               | —                          | Identical                                 |
| Daemon supervisor     | `launchDaemon` exported    | Removed — use pm2, systemd, or container  |
| Process model         | Single process             | Single process                            |
| Hot reload            | Lazy, mtime-based          | Lazy, uncached — re-read per request      |

Everything documented below applies to both, unless noted otherwise.

## Install

```bash
pnpm add fluxion-vio
pnpm add -D tsx    # Recommended: enables TypeScript hot-reload
```

## Quick Start

Create `server.ts`:

```ts
import { fluxion } from 'fluxion-vio';

await fluxion({
  dir: './dynamic',
  host: '127.0.0.1',
  port: 3000,
});
```

Create `dynamic/hello.ts`:

```ts
import { defineFluxionModule } from 'fluxion-vio';

export default defineFluxionModule(async (req, cx) => {
  return { message: 'hello vio', path: req.url.pathname };
});
```

Run:

```bash
tsx server.ts
```

Request:

```bash
curl http://127.0.0.1:3000/hello.ts
```

Response:

```json
{"message":"hello vio","path":"/hello.ts"}
```

## Routing

Files under `dir` become routes based on glob patterns:

- Files matching `apiInclude` (default: `**/*.ts`) are API handlers.
- Files matching `staticInclude` (default: `**/*`) are static resources.
- Files matching `exclude` are skipped (default: node_modules, .git, dist, etc.).
- The file extension IS part of the route.

| File                      | Route              | Type        |
| ------------------------- | ------------------ | ----------- |
| `dynamic/hello.ts`        | `/hello.ts`        | API handler |
| `dynamic/user/profile.ts` | `/user/profile.ts` | API handler |
| `dynamic/index.html`      | `/index.html`      | Static file |
| `dynamic/assets/app.js`   | `/assets/app.js`   | Static file |

## API Handlers

Every API handler **must** use `defineFluxionModule()`.

### Simple Handler

```ts
import { defineFluxionModule } from 'fluxion-vio';

export default defineFluxionModule(async (req, cx) => {
  return { ok: true };
});
```

### Handler Arguments

```ts
handler(req, cx, rawReq, rawRes)
```

- **`req`** — Normalized request object

  ```ts
  {
    method: string;                     // HTTP method
    ip: string;                         // Client IP
    url: URL;                           // Parsed URL
    query: Record<string, string | string[]>;  // Query params
    body: Record<string, any>;           // Parsed body
    headers: IncomingHttpHeaders;
    cookie: Record<string, string>;
    meta: Record<any, any>;              // Custom metadata (shared across middleware)
  }
  ```
- **`cx`** — Module context `{ logger: FluxionLogger }`
- **`rawReq`** — Node.js `http.IncomingMessage`
- **`rawRes`** — Node.js `http.ServerResponse`

### Full Module Configuration

```ts
import { defineFluxionModule, defineFluxionMiddleware } from 'fluxion-vio';

const logMiddleware = defineFluxionMiddleware(async (req, cx) => {
  cx.logger.info('request received', { path: req.url.pathname });
});

export default defineFluxionModule({
  handler: async (req, cx) => {
    return { message: 'hello' };
  },
  middlewares: [logMiddleware],
  methods: ['GET', 'POST'],
  handlerTimeoutMs: 10000,
  disposer: async () => {
    // Cleanup when file is removed or server shuts down
  },
});
```

### Module Options

```ts
interface FluxionModule {
  handler: FluxionHandler;           // Required: main handler function
  middlewares?: FluxionMiddleware[];  // Optional: middleware array
  methods?: HTTPMethod[];            // Optional: allowed HTTP methods (default: all)
  handlerTimeoutMs?: number;         // Optional: handler timeout override
  disposer?: FluxionDisposer;         // Optional: cleanup function
}
```

## Middleware

Middleware runs sequentially **before** the handler. They can modify the request via side effects.

```ts
import { defineFluxionMiddleware, defineFluxionModule } from 'fluxion-vio';

const authMiddleware = defineFluxionMiddleware(async (req, cx, rawReq, rawRes) => {
  const token = req.headers.authorization;
  if (!token) {
    rawRes.statusCode = 401;
    rawRes.end('Unauthorized');
    return;  // Short-circuit: handler won't be called
  }
  req.meta.user = await verifyToken(token);
});

export default defineFluxionModule({
  handler: async (req) => ({ user: req.meta.user }),
  middlewares: [authMiddleware],
});
```

Middleware timeout defaults to **3000ms**. Configure via `middlewareTimeoutMs`.

The example above shows *how* to hook in auth — Vio does not ship authentication itself. Small services still need to protect anything that isn't meant to be public.

## HTTP Exceptions

Throw these in handlers or middleware for clean error responses:

```ts
import { defineFluxionModule, NotFoundException, BadRequestException } from 'fluxion-vio';

export default defineFluxionModule(async (req) => {
  if (!req.query.id) {
    throw new BadRequestException('Missing id parameter');
  }

  const user = await db.findUser(req.query.id);
  if (!user) {
    throw new NotFoundException('User not found');
  }

  return { user };
});
```

| Class                           | Status |
| ------------------------------- | ------ |
| `BadRequestException`           | 400    |
| `UnauthorizedException`         | 401    |
| `ForbiddenException`            | 403    |
| `NotFoundException`             | 404    |
| `MethodNotAllowedException`     | 405    |
| `NotAcceptableException`        | 406    |
| `RequestTimeoutException`       | 408    |
| `ConflictException`             | 409    |
| `GoneException`                 | 410    |
| `PayloadTooLargeException`      | 413    |
| `UnsupportedMediaTypeException` | 415    |
| `UnprocessableEntityException`  | 422    |
| `TooManyRequestsException`      | 429    |
| `InternalServerErrorException`  | 500    |
| `NotImplementedException`       | 501    |
| `BadGatewayException`           | 502    |
| `ServiceUnavailableException`   | 503    |
| `GatewayTimeoutException`       | 504    |

## Request Body

Fluxion Vio parses request bodies before calling handlers (except for `GET` and `HEAD`).

- **JSON** (`application/json`): objects assigned directly; primitives become `{ value }`; invalid JSON becomes `{ raw }`
- **Form data** (`multipart/form-data`, `application/x-www-form-urlencoded`): parsed into key/value fields
- **Text** (`text/*`): stored as `{ raw }`
- **Binary**: read for size check; body remains `{}`

Requests larger than `maxRequestBytes` (default: 8MB) return `413 Payload Too Large`.

## Response Behavior

Returning a value produces a `200 OK` JSON response:

```ts
export default defineFluxionModule(async () => {
  return { ok: true };
});
```

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{"ok":true}
```

Write directly to `rawRes` for custom responses:

```ts
export default defineFluxionModule(async (_req, _cx, _rawReq, res) => {
  res.statusCode = 201;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('created');
});
```

When `res.writableEnded` is true, Fluxion Vio will not send another response.

## Static Files

Non-API files are served as static resources. Supported methods: `GET`, `HEAD`. Other methods return `405 Method Not Allowed`.

Known content types: `.html`, `.css`, `.js`, `.json`, `.png`, `.jpg`, `.jpeg`, `.svg`, `.txt`, `.webp`, `.ico`, `.map`. Unknown extensions use `application/octet-stream`.

## Lazy Loading

Fluxion Vio uses a **lazy loading** strategy:

- Files are loaded on demand when a request arrives.
- No module cache: every request re-reads the file from disk. `require.cache` is cleared first, so the module and its import chain are re-evaluated.
- If the file is deleted, the module is disposed and subsequent requests return `404`.
- No file watcher runs at runtime.

This means:

- **Fast startup**: No initial file scanning.
- **Automatic hot-reload**: Edit a file, and the next request picks up the change — even with the same `mtime`.
- **No watcher overhead**: No CPU/memory usage for file watching.
- **Slower requests**: Each API request pays a `require()` cost; fine for low-traffic services, not for high throughput.

Reason:

In watch mode, frequent file modifications and creation
of temporary files by AI Agents can **block the main process**, preventing
interface files from being loaded correctly (i.e., the "watch failure"
issue).

## Health checks

Fluxion Vio intentionally ships **no built-in metadata endpoints** (no `/_vio/*` routes) — nothing about the server is exposed automatically. Implement health checks yourself as ordinary API handlers, controlling the path, the auth, and exactly what gets exposed:

```ts
// healthz.ts — placed in your dynamic dir, served like any other route
import { defineFluxionModule } from 'fluxion-vio';

export default defineFluxionModule({
  handler: () => ({
    ok: true,
    now: Date.now(),
    uptimeSeconds: Number(process.uptime().toFixed(3)),
  }),
});
```

## Options

```ts
interface FluxionOptions {
  dir: string;                     // Required: dynamic directory
  host: string;                    // Required: bind address
  port: number;                    // Required: HTTP port

  // Timeouts
  handlerTimeoutMs?: number;       // Default: 5000ms
  middlewareTimeoutMs?: number;    // Default: 3000ms
  staticResourceTimeoutMs?: number; // Default: 180000ms (3 min)

  // File patterns
  apiInclude?: string[];           // Default: ['**/*.ts']
  staticInclude?: string[];        // Default: ['**/*']
  exclude?: string[];              // Overrides built-in ignore list

  // Request handling
  maxRequestBytes?: number;        // Default: 8_000_000

  // Logging
  logger?: 'one-line' | 'json-line' | FluxionLoggerFn; // Default: 'one-line'

  // Module system
  moduleDir?: string;              // Default: process.cwd()

  // HTTPS
  https?: {
    key: string | Buffer;
    cert: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>;
  };

  // Security
  csp?: string | false;            // Default: "default-src 'self'". false omits the header.
}
```

### HTTPS

```ts
fluxion({
  dir: './dynamic',
  host: '0.0.0.0',
  port: 443,
  https: {
    key: './certs/private-key.pem',
    cert: './certs/certificate.pem',
    ca: './certs/ca-bundle.crt',  // Optional
  },
});
```

Relative paths are resolved relative to `moduleDir`. PEM content can be passed directly.

For small services, terminating TLS at a reverse proxy (Caddy, nginx, a tunnel) is often simpler than managing certificates in-process.

### Custom Logger

```ts
import { fluxion, defineFluxionLogger } from 'fluxion-vio';

const myLogger = defineFluxionLogger((entry) => {
  console.log(JSON.stringify(entry));
});

await fluxion({
  dir: './dynamic',
  host: 'localhost',
  port: 3000,
  logger: myLogger,
});
```

## Security

Vio targets trusted environments. It inherits Fluxion's baseline hardening, but **it is not a security boundary**:

- **Path traversal protection**: Requests are validated to ensure the resolved path stays within the configured directory.
- **Security headers**: All responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, and `Content-Security-Policy: default-src 'self'`. Override with the `csp` option, or pass `csp: false` to omit it.
- **Error message sanitization**: Internal error details are never leaked to clients.
- **Cookie limits**: Maximum 100 cookies per request.

What Vio does **not** provide: authentication, authorization, CSRF protection, rate limiting, request signing, audit logging, or sandboxing of handler code. Handlers run with full Node.js privileges and can read and write anything the process can.

Practical guidance:

- Bind to `127.0.0.1` or a private interface unless the service is meant to be public.
- Put a reverse proxy in front for TLS, access control, and rate limiting.
- Keep secrets out of the dynamic directory — it is web-served by default.
- Never expose the service directly to the public internet without your own auth layer.

## Deployment

Vio has no built-in daemon supervisor (upstream Fluxion's `launchDaemon` was removed). Use a normal process manager:

```bash
# pm2
pm2 start "tsx server.ts" --name fluxion-vio-app

# systemd
# ExecStart=/usr/local/bin/tsx /srv/fluxion-vio/server.ts

# Docker
docker run -p 3000:3000 fluxion-vio-app
```

Because Vio is aimed at low-traffic services, a single process is usually enough. If you need clustering, run several instances behind a proxy, or switch to upstream Fluxion.

## Migrating from Fluxion

The APIs are identical. To move:

1. Replace the package and import specifier:

   ```diff
   - pnpm add fluxion-ts
   + pnpm add fluxion-vio
   ```

   ```diff
   - import { fluxion } from 'fluxion-ts';
   + import { fluxion } from 'fluxion-vio';
   ```

2. Remove any use of `launchDaemon` and run the process under pm2, systemd, or a container instead.

## Build and Test

```bash
pnpm build
pnpm test
pnpm lint
```
