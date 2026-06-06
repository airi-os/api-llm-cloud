# Topology Discovery — Tasks

## llm-proxy Changes

### Task 1: Add `/internal/v1/topology` endpoint to router

**File:** `src/router.ts`

- [ ] Import `TOPOLOGY` from `./generated/topology`
- [ ] Add `handleTopologyRequest()` function that returns `jsonResponse(TOPOLOGY)` — no runtime computation, just returns the imported constant
- [ ] Add route check at top of `handleRouterRequest`: if `GET /internal/v1/topology`, verify `X-Internal-Auth` header against `env.INTERNAL_AUTH_SECRET`, then call `handleTopologyRequest`
- [ ] Return 401 if auth header missing or mismatched

### Task 2: Extract shared naming constant in deploy script

**File:** `scripts/deploy.ts`

- [ ] Add `const WORKER_NAME_PREFIX = "llm-proxy-"` constant
- [ ] Add `const WORKER_NAME_PAD = 2` constant
- [ ] Update `generateProxyToml` to use `WORKER_NAME_PREFIX` + zero-pad
- [ ] Update `generateRouterToml` service names to use same pattern
- [ ] Update `proxyWorkers.push(...)` name to use same pattern

### Task 3: Generate topology TypeScript module in deploy script

**File:** `scripts/deploy.ts`

- [ ] Add `generateTopologyModule(proxyCount: number)` function
- [ ] Compute `topologyId` as deterministic SHA-256 hash of topology-defining fields (worker names, ordering, count, schema version)
- [ ] Compute `topologyGeneratedAt` as current timestamp at deploy time
- [ ] Generate file content for `src/generated/topology.ts` with:
  - `export const TOPOLOGY = { schemaVersion: 1, topologyId, topologyGeneratedAt, workerCount, proxies } as const`
  - `export type Topology = typeof TOPOLOGY`
- [ ] Write to `src/generated/topology.ts` after successful deploy
- [ ] Call in `main()` after `printSummary()` and before final success message
- [ ] Ensure `src/generated/` directory exists before writing (create if needed)

### Task 4: Update llm-proxy README

**File:** `README.md`

- [ ] Add "Topology Discovery" section documenting `/internal/v1/topology` endpoint
- [ ] Document `INTERNAL_AUTH_SECRET` requirement for the endpoint
- [ ] Document relationship to freellmapi-alpha
- [ ] Add architecture diagram showing discovery flow

---

## freellmapi-alpha Changes

### Task 5: Create topology client service

**File:** `server/src/services/proxyTopology.ts` (new)

- [ ] Define `TopologyProxy` interface: `{ id: number; name: string; status: 'active' | 'unknown' }`
- [ ] Define `TopologySnapshot` interface: `{ schemaVersion: number; topologyId: string; topologyGeneratedAt: number; workerCount: number; proxies: TopologyProxy[] }`
- [ ] Implement `initialize()`: fetch from `LLM_PROXY_URL/internal/v1/topology` with `X-Internal-Auth` header
- [ ] Implement `getWorkerCount()`: return `snapshot.workerCount` or fallback
- [ ] Implement `getTopology()`: return cached snapshot or null
- [ ] Implement `isDynamicTopologyAvailable()`: return whether snapshot is active
- [ ] Implement 5-second timeout on fetch
- [ ] Implement schema validation (check required fields, types)
- [ ] Implement fallback chain: topology → `PROXY_IP_COUNT` env → `0`
- [ ] Add `_reset()` and `_setMockTopology()` test helpers
- [ ] Add startup log: `[topology] discovered N workers` or `[topology] unavailable, falling back to static config`

### Task 6: Refactor ipPoolCapacity.ts

**File:** `server/src/services/ipPoolCapacity.ts`

- [ ] Import `proxyTopology` from `./proxyTopology.js`
- [ ] Rename existing `getIpCount()` to `getWorkerCount()` (or add new `getWorkerCount()` that wraps the logic)
- [ ] Update `getWorkerCount()` to use `proxyTopology.getWorkerCount()` with fallback chain
- [ ] Keep existing fallback logic for `PROXY_IP_COUNT` env var
- [ ] No changes to `allocateIp`, `hasIpCapacity`, `releaseIp`, or other functions

### Task 7: Add startup integration

**File:** `server/src/index.ts`

- [ ] Import `initialize as initTopology` from `./services/proxyTopology.js`
- [ ] Call `await initTopology()` during startup, after DB init, before `app.listen()`
- [ ] Wrap in try/catch so startup never fails due to topology issues

### Task 8: Update freellmapi-alpha README

**File:** `README.md`

- [ ] Add "Proxy Topology Discovery" section
- [ ] Document `LLM_PROXY_URL` and `INTERNAL_AUTH_SECRET` env vars
- [ ] Document fallback behavior
- [ ] Add architecture diagram showing discovery flow
- [ ] Add migration notes for existing deployments

---

## Verification

### Task 9: Manual verification

- [ ] Deploy llm-proxy locally, verify `GET /internal/v1/topology` returns correct JSON
- [ ] Verify 401 without `X-Internal-Auth` header
- [ ] Start freellmapi-alpha with `LLM_PROXY_URL` set, verify topology log
- [ ] Start freellmapi-alpha without `LLM_PROXY_URL`, verify fallback log
- [ ] Verify sticky sessions still work with dynamic IP count
- [ ] Verify `PROXY_IP_COUNT` env var still works as fallback
