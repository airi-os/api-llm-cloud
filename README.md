# airiOS - API Cloud Layer
<img width="256" height="384" alt="airiOS mascot" src="https://github.com/user-attachments/assets/c1394148-be39-44a0-9c26-a6962e951321" />

## How it works

```
Client -> Router Worker -> Proxy Worker #N -> Upstream API
```

1. You send a request to the router with a password, a proxy number, and the target URL (base64-encoded).
2. The router picks a proxy worker (`proxy_num % N`) and forwards internally.
3. The proxy worker strips all identifying headers, injects a deterministic fake IP, and calls the upstream API.
4. The response (including SSE streams) passes through untouched.

Each proxy worker gets a unique but stable fake IP per upstream domain -- no storage, no state.

## URL Format

```
POST https://router.example.com/{PASSWORD}/{PROXY_NUM}/{BASE64_URL}/{extra_path}
```

| Segment | Example | Description |
|---|---|---|
| PASSWORD | `yourpassword` | Checked against AUTH_KEY |
| PROXY_NUM | `3` | Worker selection (modulo N) |
| BASE64_URL | `aHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MQ` | URL-safe base64 of upstream base URL |
| extra_path | `chat/completions` | Appended to decoded base URL |

### Example

```
POST https://router.example.com/yourpassword/3/aHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MQ/chat/completions
Authorization: Bearer sk-your-api-key
Content-Type: application/json

{"model":"gpt-4","messages":[...],"stream":true}
```

Decoded: proxy #3 calls `https://api.openai.com/v1/chat/completions` with your key and a stable fake IP.

## URL Encoder Helper

Navigate to `https://router.example.com/{PASSWORD}` in a browser to get a client-side URL encoder page. It's behind auth so you can bookmark it. The page shows your real password in the generated URLs.

## Headers

**Passed through to upstream:** `Authorization`, `Content-Type`, `Accept`, request body.

**Stripped:** All Cloudflare headers (`CF-Connecting-IP`, `CF-RAY`, etc.), `X-Real-IP`, `Host`.

**Injected:** `X-Forwarded-For` with the deterministic fake IP.

## Setup

```bash
cp .env.example .env
# Edit .env -- set AUTH_KEY and INTERNAL_AUTH_SECRET
npm install
```

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Deploy

```bash
npm run deploy
```

Deploys 3 proxy workers + 1 router worker to Cloudflare. Configs are generated into `dist/` for inspection.

Adjust `PROXY_COUNT` in `.env` to change the number of proxy workers.


## Topology Discovery

The router worker exposes a versioned internal endpoint for topology discovery by [freellmapi-alpha](https://github.com/tashfeenahmed/freellmapi):

```
GET /internal/v1/topology
Header: X-Internal-Auth: <INTERNAL_AUTH_SECRET>
```

**Response:**

```json
{
  "schemaVersion": 1,
  "topologyId": "sha256:...",
  "topologyGeneratedAt": 1717640000,
  "workerCount": 3,
  "proxies": [
    { "id": 0, "name": "llm-proxy-00", "status": "active" },
    { "id": 1, "name": "llm-proxy-01", "status": "active" },
    { "id": 2, "name": "llm-proxy-02", "status": "active" }
  ]
}
```

- `topologyId`: Deterministic SHA-256 hash of topology-defining fields (worker names, ordering, count, schema version)
- `topologyGeneratedAt`: Deploy-time timestamp (epoch seconds)
- `workerCount`: Number of deployed proxy workers
- `proxies[]`: Each worker with `id`, `name`, and `status`

The response is generated at deploy time and embedded as a static constant — no runtime computation, no env reads, no filesystem access.

## Usage with LM Studio / OpenAI-compatible clients

Set the base URL to:
```
https://router.example.com/{PASSWORD}/{PROXY_NUM}/{BASE64_URL}
```

For OpenAI with proxy rotation, encode the base URL:
```bash
node -e "console.log(Buffer.from('https://api.openai.com/v1').toString('base64url'))"
```

Then set base URL to `https://router.example.com/yourpassword/1/<encoded>/`.

Use different `PROXY_NUM` values (1, 2, 3, ...) to rotate through different exit IPs.

## Development

```bash
npm test          # Run tests
npm run type-check # TypeScript check
npm run dev       # Local dev server
```

## Project structure

```
src/
  worker.ts     Entry point -- dispatches by WORKER_ROLE
  router.ts     Auth, proxy selection, URL decode, encoder page
  proxy.ts      Header strip, fake IP injection, upstream call
  public.ts     URL encoder helper page (behind auth)
  fake-ip.ts    SHA-256 based deterministic IP generation
  base64url.ts  URL-safe base64 encode/decode
  http.ts       Response helpers (CORS, error JSON)
  generated/
    topology.ts  Generated immutable TOPOLOGY constant (by deploy.ts)
scripts/
  deploy.ts     Auto-generates TOML configs and deploys all workers
```
