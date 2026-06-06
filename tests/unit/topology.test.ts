import { describe, it, expect } from "vitest";
import { handleRouterRequest } from "../../src/router";
import { TOPOLOGY } from "../../src/generated/topology";

const INTERNAL_SECRET = "test-internal-secret-32-chars-long!!";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_KEY: "test-auth-key",
    INTERNAL_AUTH_SECRET: INTERNAL_SECRET,
    PROXY_COUNT: "3",
    ROUTER_DOMAIN: "router.example.com",
    ...overrides,
  };
}

describe("GET /internal/v1/topology", () => {
  // ── Auth ───────────────────────────────────────────────────────────

  it("returns 401 when X-Internal-Auth header is missing", async () => {
    const req = new Request("http://router/internal/v1/topology");
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-Internal-Auth header is wrong", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": "wrong-secret" },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-Internal-Auth header is empty string", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": "" },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  // ── Success ────────────────────────────────────────────────────────

  it("returns 200 with valid auth", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
  });

  it("returns Content-Type application/json", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns the exact TOPOLOGY constant", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    const body = await res.json();
    expect(body).toEqual(TOPOLOGY);
  });

  it("returns response matching the topology schema", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    const body = await res.json();

    expect(body).toHaveProperty("schemaVersion", 1);
    expect(body).toHaveProperty("topologyId");
    expect(body).toHaveProperty("topologyGeneratedAt");
    expect(body).toHaveProperty("workerCount");
    expect(body).toHaveProperty("proxies");
    expect(Array.isArray(body.proxies)).toBe(true);
  });

  it("returns topologyId as a string starting with sha256:", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    const body = await res.json();

    expect(typeof body.topologyId).toBe("string");
    expect(body.topologyId).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("returns workerCount as a non-negative integer", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    const body = await res.json();

    expect(Number.isInteger(body.workerCount)).toBe(true);
    expect(body.workerCount).toBeGreaterThanOrEqual(0);
  });

  it("returns proxies as an array of objects with id, name, status", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    const body = await res.json();

    for (const proxy of body.proxies) {
      expect(proxy).toHaveProperty("id");
      expect(proxy).toHaveProperty("name");
      expect(proxy).toHaveProperty("status");
      expect(["active", "unknown"]).toContain(proxy.status);
    }
  });

  it("does not expose AUTH_KEY or INTERNAL_AUTH_SECRET in response", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    const body = await res.json();

    const responseStr = JSON.stringify(body);
    expect(responseStr).not.toContain("AUTH_KEY");
    expect(responseStr).not.toContain(INTERNAL_SECRET);
  });

  // ── Method check ───────────────────────────────────────────────────

  it("only responds to GET (not POST)", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      method: "POST",
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    // POST to /internal/v1/topology falls through to the normal routing logic
    // which expects /{AUTH_KEY}/{PROXY_NUM}/{BASE64_URL} — so it returns 403
    // (no matching AUTH_KEY segment)
    expect(res.status).not.toBe(200);
  });

  // ── CORS ───────────────────────────────────────────────────────────

  it("returns CORS headers on the topology response", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      headers: { "X-Internal-Auth": INTERNAL_SECRET },
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // ── OPTIONS preflight ──────────────────────────────────────────────

  it("returns 204 for OPTIONS preflight to topology path", async () => {
    const req = new Request("http://router/internal/v1/topology", {
      method: "OPTIONS",
    });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(204);
  });
});
