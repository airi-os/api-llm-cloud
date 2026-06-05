# AGENTS.md — Developer Guide

## Architecture

Single codebase, dual-role workers dispatched by `WORKER_ROLE` env var:

- **Router** (`src/router.ts`) — public endpoint. Validates AUTH_KEY from URL path, decodes base64 target URL, selects proxy via `PROXY_NUM % PROXY_COUNT`, forwards via service binding with `X-Internal-Auth` / `X-Target-URL` / `X-Original-Method` headers.
- **Proxy** (`src/proxy.ts`) — no public route. Validates `X-Internal-Auth`, generates fake IP from `SHA-256(proxy_index + domain)`, strips identity headers, passes through `Authorization`/`Content-Type`/`Accept` and body untouched, streams response back.

Entry point is `src/worker.ts` — a switch on `env.WORKER_ROLE` that delegates to the correct handler.

## Key design constraints

- No body parsing — pure pass-through
- No credential storage — client provides its own API key
- No Durable Objects, no KV, no state
- URL-safe base64 only (RFC 4648 §5)
- Fake IPs are deterministic: `SHA-256(proxy_index + domain)[0:4]` → IPv4

## Auth flow

1. Client sends password in URL path segment 1
2. Router checks it against `AUTH_KEY` env var
3. Router forwards to proxy with `X-Internal-Auth` = `INTERNAL_AUTH_SECRET`
4. Proxy validates `X-Internal-Auth` against its own `INTERNAL_AUTH_SECRET`

Both values come from `.env`. Proxy workers have no public routes — service binding only.

## Deployment

`npm run deploy` runs `scripts/deploy.ts` which:

1. Loads `.env` (validates AUTH_KEY ≥8 chars, INTERNAL_AUTH_SECRET ≥32 chars)
2. Generates TOML configs into `dist/` — one per proxy + router
3. Deploys proxies in parallel (staggered 1s apart)
4. Deploys router last (depends on proxy service bindings)
5. Retries failed deploys up to 3x with exponential backoff (2s, 4s, 8s)

Proxy count is controlled by `PROXY_COUNT` in `.env` (default: 3).

Router gets custom domain `router.example.com` via Cloudflare.

## Testing

```bash
npm test           # vitest — 45 unit + integration tests
npm run type-check # tsc --noEmit
```

Tests use mocked service bindings (`vi.fn()`) for router→proxy calls. Integration test (`tests/integration/full-flow.test.ts`) covers the full pipeline.

## Modifying the proxy count

1. Change `PROXY_COUNT` in `.env`
2. `npm run deploy` regenerates all configs automatically
3. The router TOML includes the correct number of `[[services]]` bindings

## File reference

| File | Purpose |
|---|---|
| `src/worker.ts` | Entry: dispatch by WORKER_ROLE |
| `src/router.ts` | Auth + URL decode + proxy selection |
| `src/proxy.ts` | Internal auth + header strip + fake IP + upstream fetch |
| `src/fake-ip.ts` | `SHA-256(index + domain)` → deterministic IPv4 |
| `src/base64url.ts` | URL-safe base64 encode/decode |
| `src/http.ts` | CORS headers, JSON/error response helpers |
| `scripts/deploy.ts` | Generate TOML + deploy all workers |
| `wrangler.toml` | Base config (used by `wrangler dev` locally) |
| `.env` | Secrets (gitignored) |
| `.env.example` | Template for required env vars |
