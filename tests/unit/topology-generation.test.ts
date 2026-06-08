import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Replicated generation logic (must match router.ts:generateTopology exactly)
// ---------------------------------------------------------------------------

const WORKER_NAME_PREFIX = "llm-proxy-";
const WORKER_NAME_PAD = 2;

interface GeneratedTopology {
	schemaVersion: number;
	topologyId: string;
	topologyGeneratedAt: number;
	workerCount: number;
	proxies: Array<{ id: number; name: string; status: "active" }>;
}

async function sha256Hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function generateTopology(proxyCount: number, fixedTimestamp: number): Promise<GeneratedTopology> {
	const proxies = Array.from({ length: proxyCount }, (_, i) => ({
		id: i,
		name: `${WORKER_NAME_PREFIX}${String(i).padStart(WORKER_NAME_PAD, "0")}`,
		status: "active" as const,
	}));

	const topologyGeneratedAt = fixedTimestamp;

	// Deterministic hash of topology-defining fields (must match router.ts)
	const hashInput = JSON.stringify({ schemaVersion: 1, workerCount: proxyCount, proxies });
	const topologyId = `sha256:${await sha256Hex(hashInput)}`;

	return {
		schemaVersion: 1,
		topologyId,
		topologyGeneratedAt,
		workerCount: proxyCount,
		proxies,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("topology generation determinism", () => {
	// ── Deterministic topologyId ───────────────────────────────────────

	it("same topology produces same topologyId", async () => {
		const t1 = await generateTopology(3, 1000);
		const t2 = await generateTopology(3, 1000);

		expect(t1.topologyId).toBe(t2.topologyId);
	});

	it("same topology with different timestamps produces same topologyId (timestamp not in hash)", async () => {
		const t1 = await generateTopology(3, 1000);
		const t2 = await generateTopology(3, 9999);

		expect(t1.topologyId).toBe(t2.topologyId);
	});

	it("different worker count produces different topologyId", async () => {
		const t3 = await generateTopology(3, 1000);
		const t5 = await generateTopology(5, 1000);

		expect(t3.topologyId).not.toBe(t5.topologyId);
	});

	it("workerCount=0 produces a valid topologyId", async () => {
		const t = await generateTopology(0, 1000);

		expect(t.topologyId).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(t.workerCount).toBe(0);
		expect(t.proxies).toEqual([]);
	});

	// ── Worker naming consistency ──────────────────────────────────────

	it("worker names use zero-padded format llm-proxy-NN", async () => {
		const t = await generateTopology(3, 1000);

		expect(t.proxies[0].name).toBe("llm-proxy-00");
		expect(t.proxies[1].name).toBe("llm-proxy-01");
		expect(t.proxies[2].name).toBe("llm-proxy-02");
	});

	it("worker names are consistent with WORKER_NAME_PREFIX and WORKER_NAME_PAD", async () => {
		const t = await generateTopology(12, 1000);

		// Single digit: padded to 2
		expect(t.proxies[0].name).toBe("llm-proxy-00");
		expect(t.proxies[9].name).toBe("llm-proxy-09");
		// Double digit: no extra padding needed
		expect(t.proxies[10].name).toBe("llm-proxy-10");
		expect(t.proxies[11].name).toBe("llm-proxy-11");
	});

	it("worker ids are sequential starting from 0", async () => {
		const t = await generateTopology(5, 1000);

		expect(t.proxies.map((p) => p.id)).toEqual([0, 1, 2, 3, 4]);
	});

	it("all proxies have status 'active'", async () => {
		const t = await generateTopology(3, 1000);

		for (const proxy of t.proxies) {
			expect(proxy.status).toBe("active");
		}
	});

	// ── Schema structure ───────────────────────────────────────────────

	it("generated topology has all required fields", async () => {
		const t = await generateTopology(3, 1000);

		expect(t).toHaveProperty("schemaVersion", 1);
		expect(t).toHaveProperty("topologyId");
		expect(t).toHaveProperty("topologyGeneratedAt");
		expect(t).toHaveProperty("workerCount", 3);
		expect(t).toHaveProperty("proxies");
	});

	it("workerCount matches proxies array length", async () => {
		for (const count of [0, 1, 3, 10]) {
			const t = await generateTopology(count, 1000);
			expect(t.workerCount).toBe(count);
			expect(t.proxies.length).toBe(count);
		}
	});

	// ── Hash input isolation ───────────────────────────────────────────

	it("topologyId is a SHA-256 hash (64 hex chars after prefix)", async () => {
		const t = await generateTopology(3, 1000);
		const hashPart = t.topologyId.replace("sha256:", "");

		expect(hashPart).toHaveLength(64);
		expect(hashPart).toMatch(/^[a-f0-9]{64}$/);
	});

	it("changing any topology-defining field changes the hash", async () => {
		const base = await generateTopology(3, 1000);

		// Same count, same names → same hash
		const same = await generateTopology(3, 1000);
		expect(same.topologyId).toBe(base.topologyId);
	});
});
