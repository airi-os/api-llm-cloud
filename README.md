# LLM Proxy

Rotate exit IPs across multiple Cloudflare Workers so a single machine can use multiple API keys without upstream bans or rate limits caused by a shared IP.

## How it works

```
Client → Router Worker → Proxy Worker #N → Upstream API
```

1. You send a request to the router with a password, a proxy number, and the target URL (base64-encoded).
2. The router picks a proxy worker (`proxy_num % N`) and forwards internally.
3. The proxy worker strips all identifying headers, injects a deterministic fake IP, and calls the upstream API.
4. The response (including SSE streams) passes through untouched.

Each proxy worker gets a unique but stable fake IP per upstream domain — no storage, no state.

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

## Headers

**Passed through to upstream:** `Authorization`, `Content-Type`, `Accept`, request body.

**Stripped:** All Cloudflare headers (`CF-Connecting-IP`, `CF-RAY`, etc.), `X-Real-IP`, `Host`.

**Injected:** `X-Forwarded-For` with the deterministic fake IP.

## Setup

```bash
cp .env.example .env
# Edit .env — set AUTH_KEY and INTERNAL_AUTH_SECRET
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
  worker.ts     Entry point — dispatches by WORKER_ROLE
  router.ts     Auth, proxy selection, URL decode
  proxy.ts      Header strip, fake IP injection, upstream call
  fake-ip.ts    SHA-256 based deterministic IP generation
  base64url.ts  URL-safe base64 encode/decode
  http.ts       Response helpers (CORS, error JSON)
scripts/
  deploy.ts     Auto-generates TOML configs and deploys all workers
```
