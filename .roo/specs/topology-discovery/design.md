# Topology Discovery — Design

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  llm-proxy (Cloudflare Workers)                                     │
│                                                                     │
│  deploy.ts                                                          │
│    ├── reads PROXY_COUNT env (deploy-time input only)               │
│    ├── generates proxy-NN.toml + router.toml                        │
│    ├── deploys via wrangler                                         │
│    └── generates src/generated/topology.ts  ◀── NEW                │
│         (immutable constant: TOPOLOGY)                              │
│                                                                     │
│  src/generated/topology.ts  ◀── NEW (generated, not hand-written)   │
│    └── export const TOPOLOGY = { ... } as const                     │
│                                                                     │
│  router worker                                                      │
│    ├── GET /{AUTH_KEY}/{PROXY_NUM}/{BASE64_URL}/...                │
│    │     → proxyBinding.fetch() ──▶ upstream API                   │
│    │                                                               │
│    └── GET /internal/v1/topology  ◀── NEW                          │
│          (auth: X-Internal-Auth)                                    │
│          → returns imported TOPOLOGY constant                       │
│          → no runtime computation, no env reads, no fs reads        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
           │
           │  GET /internal/v1/topology
           │  (X-Internal-Auth: <REDACTED>
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  freellmapi-alpha (Express / Node.js)                               │
│                                                                     │
│  server/src/services/proxyTopology.ts  ◀── NEW                     │
│   {                                                                 │
│    ├── fetchTopology() → GET /internal/v1/topology                │
│    ├── validate schema                                              │
│    ├── cache snapshot in memory                                     │
│    ├── fallback: env.PROXY_IP_COUNT → 0                            │
│    └── expose: getWorkerCount(), getTopology(), isDynamicTopologyAvailable() │
│   }                                                                 │
│                                                                     │
│  server/src/services/ipPoolCapacity.ts  ◀── MODIFIED                │
│   {                                                                 │
│    ├── getWorkerCount() now calls proxyTopology.getWorkerCount()   │
│    └── fallback chain: topology → env → 0                           │
│   }                                                                 │
│                                                                     │
│  server/src/index.ts  ◀── MODIFIED                                │
│   {                                                                 │
│    └── startup: initialize proxyTopology                           │
│   }                                                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Startup (one-time)

```
freellmapi-alpha starts
  → proxyTopology.initialize()
    → fetch(LLM_PROXY_URL + '/internal/v1/topology', { X-Internal-Auth })
    → on success: cache snapshot, log "[topology] discovered N workers"
    → on failure: log "[topology] unavailable, falling back to static config"
  → ipPoolCapacity uses proxyTopology.getWorkerCount()
```

### Runtime (per-request, unchanged)

```
Request arrives at /v1/chat/completions
  → router.routeRequest()
    → ipPoolCapacity.hasIpCapacity(platform, keyId)
      → proxyTopology.getWorkerCount()  [was: process.env.PROXY_IP_COUNT]
    → allocateIp(sessionKey, platform, keyId)
    → ... (unchanged)
```

## Data Flow Diagram

```
deploy.ts
  -> src/generated/topology.ts (immutable constant)
  -> router imports TOPOLOGY statically

freellmapi-alpha  --GET /internal/v1/topology-->  llm-proxy/router
                    <--JSON topology--             (auth: INTERNAL_AUTH_SECRET)
```

## File Changes

### llm-proxy

| File | Change |
|---|---|
| `src/router.ts` | Add `/internal/v1/topology` route handler before existing auth check |
| `scripts/deploy.ts` | Add `generateTopologyModule()` function; call after successful deploy; extract `WORKER_NAME_PREFIX` constant; use it in TOML generation |
| `src/generated/topology.ts` | **New file** (generated) — contains immutable `TOPOLOGY` constant |

### freellmapi-alpha

| File | Change |
|---|---|
| `server/src/services/proxyTopology.ts` | **New file** — topology client service with fetch, validate, cache, fallback chain |
| `server/src/services/ipPoolCapacity.ts` | Replace `process.env.PROXY_IP_COUNT` with `proxyTopology.getWorkerCount()` |
| `server/src/index.ts` | Add topology initialization on startup |

## Topology Manifest Schema

```json
{
  "schemaVersion": 1,
  "topologyId": "sha256:...",
  "topologyGeneratedAt": 1717640000,
  "workerCount": 3,
  "proxies": [
    { "id": 0, "name": "llm-proxy-00", "status": "active" },
    { "id": 1, "name": "llm-proxy-01", "status": "active" }
  ]
}
```

- `topologyId`: Deterministic hash of topology-defining fields (worker names, ordering, count, schema version)
- `topologyGeneratedAt`: Set once during deploy script execution
- `workerCount`: Derived from `PROXY_COUNT` env var
- `proxies[]`: Zero-padded worker names with status tracking

## Topology Endpoint Response Schema

```json
{
  "schemaVersion": 1,
  "topologyId": "sha256:...",
  "topologyGeneratedAt": 1717640000,
  "workerCount": 3,
  "proxies": [
    { "id": 0, "name": "llm-proxy-00", "status": "active" },
    { "id": 1, "name": "llm-proxy-01", "status": "active" }
  ]
}
```

- `schemaVersion`: Incremented for future breaking changes
- `topologyId`: Deterministic hash of topology-defining fields
- `topologyGeneratedAt`: Deploy-time timestamp
- `workerCount`: Number of workers (derived from `PROXY_COUNT`)
- `proxies[]`: Each worker with `id`, `name`, and `status` (`active`/`unknown`)

## New Environment Variables (freellmapi-alpha)

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PROXY_URL` | No | — | Base URL of llm-proxy router (e.g., `https://router.example.com`). If unset, topology discovery is skipped. |
| `INTERNAL_AUTH_SECRET` | No | — | Must match llm-proxy's `INTERNAL_AUTH_SECRET`. If unset but `LLM_PROXY_URL` is set, discovery will fail with 401. |
| `PROXY_IP_COUNT` | No | `0` | Static fallback when topology discovery is unavailable. |

## proxyTopology.ts — Interface Design

```typescript
// server/src/services/proxyTopology.ts

export interface TopologyProxy {
  id: number;
  name: string;
  status: 'active' | 'unknown';
}

export interface TopologySnapshot {
  schemaVersion: number;
  topologyId: string;
  topologyGeneratedAt: number;
  workerCount: number;
  proxies: TopologyProxy[];
}

// Public API
export function initialize(): Promise<void>;
export function getWorkerCount(): number;
export function getTopology(): TopologySnapshot | null;
export function isDynamicTopologyAvailable(): boolean;

// For testing
export function _reset(): void;
export function _setMockTopology(topology: TopologySnapshot | null): void;
```

## ipPoolCapacity.ts — Changes

The only change is in `getWorkerCount()`:

```typescript
// Before
export function getIpCount(): number {
  const raw = process.env.PROXY_IP_COUNT;
  const count = raw ? parseInt(raw, 10) : 0;
  return Number.isInteger(count) && count > 0 ? count : 0;
}

// After
export function getWorkerCount(): number {
  // Dynamic topology takes priority — use availability check, not count > 0
  // because zero-worker topology is still dynamically available (disables IP limits intentionally)
  if (proxyTopology.isDynamicTopologyAvailable()) {
    return proxyTopology.getWorkerCount();
  }

  // Static fallback
  const raw = process.env.PROXY_IP_COUNT;
  const count = raw ? parseInt(raw, 10) : 0;
  return Number.isInteger(count) && count > 0 ? count : 0;
}
```

All other functions (`hasIpCapacity`, `allocateIp`, `releaseIp`, etc.) remain unchanged — they all call `getWorkerCount()` internally.

## router.ts — Changes

Add a new code path at the top of `handleRouterRequest`:

```typescript
// Internal topology endpoint (before auth check for client requests)
if (request.method === "GET") {
  const url = new URL(request.url);
  if (url.pathname === "/internal/v1/topology") {
    const authHeader = request.headers.get("X-Internal-Auth");
    if (authHeader !== env.INTERNAL_AUTH_SECRET) {
      return errorResponse("Unauthorized", 401);
    }
    return handleTopologyRequest();
  }
}
```

The `handleTopologyRequest` function returns the imported `TOPOLOGY` constant directly — no runtime computation, no env reads:

```typescript
import { TOPOLOGY } from "./generated/topology";

function handleTopologyRequest(): Response {
  return jsonResponse(TOPOLOGY);
}
```

## deploy.ts — Changes

1. Extract `WORKER_NAME_PREFIX = "llm-proxy-"` constant
2. Add `generateTopologyModule(proxyCount: number)` function
3. Call it after successful deploy, writing to `src/generated/topology.ts`
4. Use the shared naming constant in `generateProxyToml` and `generateRouterToml`

## Startup Integration (index.ts)

Add to the startup sequence:

```typescript
import { initialize as initTopology } from './services/proxyTopology.js';

// During startup, after DB init, before listening:
await initTopology();
```

## Error Handling

| Scenario | Behavior |
|---|---|
| `LLM_PROXY_URL` not set | Topology discovery skipped; `PROXY_IP_COUNT` env used |
| `INTERNAL_AUTH_SECRET` mismatch | 401 from llm-proxy; topology fetch fails; env fallback |
| Network timeout (5s) | Log warning; env fallback |
| Invalid JSON response | Log warning; env fallback |
| `PROXY_IP_COUNT` also unset | `getWorkerCount()` returns 0; IP capacity disabled (no limits) |

## Migration Path

**No breaking changes.** The migration is additive:

1. Deploy updated llm-proxy (adds `/internal/v1/topology` endpoint)
2. Set `LLM_PROXY_URL` and `INTERNAL_AUTH_SECRET` in freellmapi-alpha `.env`
3. Deploy updated freellmapi-alpha
4. Optionally remove `PROXY_IP_COUNT` from freellmapi-alpha `.env` (still works as fallback)

Existing deployments without `LLM_PROXY_URL` continue to work exactly as before.

## Topology Ownership Doctrine

- `llm-proxy` is the authoritative owner of topology metadata
- `freellmapi-alpha` consumes topology snapshots — it never derives topology independently
- Deployment metadata is authoritative over runtime env vars
- `PROXY_COUNT` is a deploy-time input only — never consumed at router runtime for topology generation
- The deploy script is the single source of truth for worker count, naming, and topology identity
- Runtime discovery must remain lightweight and deterministic
- `PROXY_IP_COUNT` fallback exists solely for backward compatibility and degraded operation — it is not considered authoritative when dynamic topology is available

## Design Principles

- **Deploy-authoritative**: Topology is generated at deploy time and immutable at runtime
- **Immutable snapshots**: Updates replace the entire snapshot atomically
- **Deterministic identity**: `topologyId` ensures stable identity across refreshes
- **Availability independence**: Topology availability tracked separately from worker count
- **Future-proof**: Designed to support future periodic refresh without architectural redesign
- **Operationally boring**: Minimal moving parts, no dynamic computation at runtime

## Bonus (ONLY if trivial)

- Add periodic topology refresh (bonus only if implementation remains clean)
- Add simple in-memory caching of topology snapshots
- Add topology version field for future schema migrations
