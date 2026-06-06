# Topology Discovery — Requirements

## Goal

Eliminate manual synchronization of `PROXY_IP_COUNT` between `llm-proxy` and `freellmapi-alpha`. Replace the static env var with runtime topology discovery so that `freellmapi-alpha` automatically discovers the deployed proxy topology from `llm-proxy`.

## Constraints

- No databases, no distributed coordination, no Redis, no WebSockets
- No redesign of routing, bandit, or provider adapters
- Backward-compatible: `PROXY_IP_COUNT` env var remains a valid fallback
- Deterministic, operationally boring
- Phase 1 only: deploy-authoritative immutable topology discovery with graceful fallback

---

## Topology Ownership Doctrine

- `llm-proxy` is the authoritative owner of topology metadata
- `freellmapi-alpha` consumes topology snapshots — it never derives topology independently
- Deployment metadata is authoritative over runtime env vars
- `PROXY_COUNT` is a deploy-time input only — never consumed at router runtime for topology generation
- The deploy script is the single source of truth for worker count, naming, and topology identity
- Runtime discovery must remain lightweight and deterministic
- `PROXY_IP_COUNT` fallback exists solely for backward compatibility and degraded operation — it is not considered authoritative when dynamic topology is available

---

## Part 1 — llm-proxy Topology Endpoint

### REQ-1.1: Versioned internal topology endpoint

The llm-proxy router worker SHALL expose `GET /internal/v1/topology`.

### REQ-1.2: Authentication

The endpoint SHALL be protected by the `INTERNAL_AUTH_SECRET` env var. Requests without a matching `X-Internal-Auth` header SHALL return 401.

### REQ-1.3: Response format

The endpoint SHALL return JSON with the following schema:

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

### REQ-1.4: Deploy-authoritative topology

The topology response SHALL be generated from a deploy-generated TypeScript module (`src/generated/topology.ts`). The router SHALL NOT derive topology from `PROXY_COUNT` env vars, runtime filesystem reads, or request-time computation.

### REQ-1.5: No secret exposure

The response SHALL NOT include `AUTH_KEY`, `INTERNAL_AUTH_SECRET`, or any other credential.

### REQ-1.6: Immutable snapshots

The topology snapshot returned by the endpoint SHALL be an immutable, deploy-time constant. The same snapshot is returned for every request until the next deploy.

Topology snapshots are treated as immutable value objects across both systems (llm-proxy runtime and freellmapi-alpha cached snapshots). Mutation-in-place is forbidden. Updates replace the entire snapshot atomically.

### REQ-1.7: Lightweight and stateless

The endpoint SHALL NOT maintain in-memory state. It SHALL return a statically imported constant.

---

## Part 2 — Deploy Script Topology Generation

### REQ-2.1: Generated TypeScript module

The deploy script SHALL generate `src/generated/topology.ts` containing a `TOPOLOGY` constant with the following shape:

```typescript
export const TOPOLOGY = {
  schemaVersion: 1,
  topologyGeneratedAt: 1717640000,
  topologyId: "sha256:...",
  workerCount: 3,
  proxies: [
    { id: 0, name: "llm-proxy-00", status: "active" },
    { id: 1, name: "llm-proxy-01", status: "active" },
    { id: 2, name: "llm-proxy-02", status: "active" }
  ]
} as const;
```

### REQ-2.2: Single source of truth

The deploy script SHALL be the authoritative source for:
- Worker count (from `PROXY_COUNT` env var)
- Worker naming (zero-padded: `llm-proxy-NN`)
- Service bindings (derived from count)
- Topology identity (deterministic hash of contents)

### REQ-2.3: No duplicated constants

Worker naming pattern SHALL be defined once and reused across TOML generation, service binding generation, and topology module generation.

### REQ-2.4: Deterministic topologyId

`topologyId` SHALL be generated deterministically from topology-defining fields only: worker names, worker ordering, worker count, and schema version. Non-topology metadata (timestamps, comments, formatting) SHALL NOT affect topologyId. It SHALL NOT be random.

### REQ-2.5: Deploy-time topologyGeneratedAt

`topologyGeneratedAt` SHALL be set once during deploy script execution. It SHALL NOT use request-time timestamps.

### REQ-2.6: No runtime filesystem reads

The deploy script SHALL NOT generate `dist/topology.json` or any other runtime-read manifest file. All topology data SHALL be embedded in the generated TypeScript module.

### REQ-2.7: Generated module lifecycle

The generated topology module is produced only during deploy/build workflows and is never regenerated at runtime.

---

## Part 3 — freellmapi-alpha Topology Client

### REQ-3.1: Service location

A new service SHALL be created at `server/src/services/proxyTopology.ts`.

### REQ-3.2: Fetch topology

The service SHALL fetch topology from `GET /internal/v1/topology` on the llm-proxy router, using the `X-Internal-Auth` header with the shared `INTERNAL_AUTH_SECRET`.

### REQ-3.3: Schema validation

The service SHALL validate the response shape. Invalid responses SHALL be rejected with a logged warning.

### REQ-3.4: Timeout

The fetch SHALL use a configurable timeout (default 5 seconds). On timeout, the service SHALL fall back to static config.

### REQ-3.5: Graceful failure

If the topology fetch fails for any reason (network, auth, parse), the service SHALL:
1. Log a single warning
2. Fall back to `PROXY_IP_COUNT` env var
3. If env var is also unset, fall back to `0` (no IP capacity limits)

### REQ-3.6: Snapshot exposure

The service SHALL expose:
- `getWorkerCount(): number` — current effective worker count
- `getTopology(): TopologySnapshot | null` — full topology or null if unavailable
- `isDynamicTopologyAvailable(): boolean` — whether a valid topology snapshot was successfully fetched and validated

### REQ-3.7: Immutable snapshot storage

The service SHALL store the topology snapshot as an immutable value. On successful fetch, the previous snapshot SHALL be atomically replaced. Partial mutation of snapshots is forbidden.

### REQ-3.8: Availability independent of worker count

Topology availability SHALL be tracked independently from `workerCount`. A valid topology with zero workers SHALL still be considered dynamically available and SHALL disable IP capacity limits.

### REQ-3.9: Future refresh compatibility

The immutable snapshot model is intentionally designed to support future periodic refresh without architectural redesign.

### REQ-3.10: Startup initialization

The topology client SHALL be initialized once during freellmapi-alpha startup, before the first request can be routed.

---

## Part 4 — Replace PROXY_IP_COUNT Usage

### REQ-4.1: Refactor ipPoolCapacity.ts

All calls to the IP count source in `ipPoolCapacity.ts` SHALL use `proxyTopology.getWorkerCount()` instead of reading `process.env.PROXY_IP_COUNT` directly.

### REQ-4.2: Preserve semantics

The fallback chain SHALL be:
1. Dynamic topology (if `isDynamicTopologyAvailable()` is true)
2. `PROXY_IP_COUNT` env var (backward compatibility fallback only — not authoritative when dynamic topology is available)
3. `0` (no IP capacity limits — backward compatible default)

### REQ-4.3: No behavioral changes

Sticky session behavior, allocation logic, and capacity checks SHALL remain unchanged. Only the source of the count value changes.

---

## Part 5 — Startup Integration

### REQ-5.1: Initialization sequence

On startup, freellmapi-alpha SHALL:
1. Initialize topology client
2. Attempt to fetch topology
3. Log result

### REQ-5.2: Success log

On successful discovery:
```
[topology] discovered 8 proxies
```

### REQ-5.3: Fallback log

On failure:
```
[topology] unavailable, falling back to static config
```

### REQ-5.4: No log spam

The topology client SHALL NOT log on every request. Only on initialization and on state transitions (available -> unavailable and back).

---

## Part 6 — Documentation

### REQ-6.1: llm-proxy README

Update to document:
- The `/internal/v1/topology` endpoint
- `INTERNAL_AUTH_SECRET` requirement
- The `src/generated/topology.ts` module
- Topology ownership doctrine
- Relationship to freellmapi-alpha

### REQ-6.2: freellmapi-alpha README

Update to document:
- Topology discovery feature
- Required env vars (`LLM_PROXY_URL`, `INTERNAL_AUTH_SECRET`)
- Fallback behavior
- Deployment flow

### REQ-6.3: Architecture diagram

Add a diagram showing the discovery flow:
```
deploy.ts
  -> src/generated/topology.ts (immutable constant)
  -> router imports TOPOLOGY statically

freellmapi-alpha  --GET /internal/v1/topology-->  llm-proxy/router
                    <--JSON topology--             (auth: INTERNAL_AUTH_SECRET)
```

---

## Out of Scope (Phase 1)

- Periodic topology refresh
- Health scoring of individual proxies
- Dynamic reconfiguration of worker bindings
- WebSocket or SSE-based topology streaming
- Kubernetes-style service discovery
- Any changes to the bandit router
- Any changes to provider adapters
- Database persistence of topology
- Runtime worker enumeration via Cloudflare API
- Dynamic reconciliation between systems
- Provider-aware proxy routing
