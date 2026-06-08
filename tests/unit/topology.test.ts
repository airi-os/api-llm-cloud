import { describe, it, expect } from "vitest";
import { handleRouterRequest } from "../../src/router";

const INTERNAL_SECRET = "test-internal-secret-32-chars-long!!";

function makeEnv(overrides: Record<string, unknown> = {}) {
	return {
		AUTH_KEY: "test-auth-key",
		INTERNAL_AUTH_SECRET: INTERNAL_SECRET,
		PROXY_COUNT: "3",
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

	it("returns workerCount matching PROXY_COUNT env", async () => {
		const req = new Request("http://router/internal/v1/topology", {
			headers: { "X-Internal-Auth": INTERNAL_SECRET },
		});
		const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
		const body = await res.json();

		expect(body.workerCount).toBe(3);
	});

	it("returns workerCount matching a different PROXY_COUNT", async () => {
		const req = new Request("http://router/internal/v1/topology", {
			headers: { "X-Internal-Auth": INTERNAL_SECRET },
		});
		const res = await handleRouterRequest(req, makeEnv({ PROXY_COUNT: "5" }), {} as ExecutionContext);
		const body = await res.json();

		expect(body.workerCount).toBe(5);
		expect(body.proxies.length).toBe(5);
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
			expect(proxy.status).toBe("active");
		}
	});

	it("returns proxy names in zero-padded format llm-proxy-NN", async () => {
		const req = new Request("http://router/internal/v1/topology", {
			headers: { "X-Internal-Auth": INTERNAL_SECRET },
		});
		const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
		const body = await res.json();

		expect(body.proxies[0].name).toBe("llm-proxy-00");
		expect(body.proxies[1].name).toBe("llm-proxy-01");
		expect(body.proxies[2].name).toBe("llm-proxy-02");
	});

	it("returns proxy ids sequential from 0", async () => {
		const req = new Request("http://router/internal/v1/topology", {
			headers: { "X-Internal-Auth": INTERNAL_SECRET },
		});
		const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
		const body = await res.json();

		expect(body.proxies.map((p: { id: number }) => p.id)).toEqual([0, 1, 2]);
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
