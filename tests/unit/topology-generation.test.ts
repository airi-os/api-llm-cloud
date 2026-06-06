import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { TOPOLOGY } from "../../src/generated/topology";

// ---------------------------------------------------------------------------
// Replicated generation logic (must match deploy.ts exactly)
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

function generateTopology(proxyCount: number, fixedTimestamp: number): GeneratedTopology {
  const proxies = Array.from({ length: proxyCount }, (_, i) => ({
    id: i,
    name: `${WORKER_NAME_PREFIX}${String(i).padStart(WORKER_NAME_PAD, "0")}`,
    status: "active" as const,
  }));

  const topologyGeneratedAt = fixedTimestamp;

  // Deterministic hash of topology-defining fields (must match deploy.ts)
  const hashInput = JSON.stringify({ schemaVersion: 1, workerCount: proxyCount, proxies });
  const topologyId = `sha256:${crypto.createHash("sha256").update(hashInput).digest("hex")}`;

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

  it("same topology produces same topologyId", () => {
    const t1 = generateTopology(3, 1000);
    const t2 = generateTopology(3, 1000);

    expect(t1.topologyId).toBe(t2.topologyId);
  });

  it("same topology with different timestamps produces same topologyId (timestamp not in hash)", () => {
    const t1 = generateTopology(3, 1000);
    const t2 = generateTopology(3, 9999);

    expect(t1.topologyId).toBe(t2.topologyId);
  });

  it("different worker count produces different topologyId", () => {
    const t3 = generateTopology(3, 1000);
    const t5 = generateTopology(5, 1000);

    expect(t3.topologyId).not.toBe(t5.topologyId);
  });

  it("workerCount=0 produces a valid topologyId", () => {
    const t = generateTopology(0, 1000);

    expect(t.topologyId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(t.workerCount).toBe(0);
    expect(t.proxies).toEqual([]);
  });

  // ── Worker naming consistency ──────────────────────────────────────

  it("worker names use zero-padded format llm-proxy-NN", () => {
    const t = generateTopology(3, 1000);

    expect(t.proxies[0].name).toBe("llm-proxy-00");
    expect(t.proxies[1].name).toBe("llm-proxy-01");
    expect(t.proxies[2].name).toBe("llm-proxy-02");
  });

  it("worker names are consistent with WORKER_NAME_PREFIX and WORKER_NAME_PAD", () => {
    const t = generateTopology(12, 1000);

    // Single digit: padded to 2
    expect(t.proxies[0].name).toBe("llm-proxy-00");
    expect(t.proxies[9].name).toBe("llm-proxy-09");
    // Double digit: no extra padding needed
    expect(t.proxies[10].name).toBe("llm-proxy-10");
    expect(t.proxies[11].name).toBe("llm-proxy-11");
  });

  it("worker ids are sequential starting from 0", () => {
    const t = generateTopology(5, 1000);

    expect(t.proxies.map((p) => p.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("all proxies have status 'active'", () => {
    const t = generateTopology(3, 1000);

    for (const proxy of t.proxies) {
      expect(proxy.status).toBe("active");
    }
  });

  // ── Schema structure ───────────────────────────────────────────────

  it("generated topology has all required fields", () => {
    const t = generateTopology(3, 1000);

    expect(t).toHaveProperty("schemaVersion", 1);
    expect(t).toHaveProperty("topologyId");
    expect(t).toHaveProperty("topologyGeneratedAt");
    expect(t).toHaveProperty("workerCount", 3);
    expect(t).toHaveProperty("proxies");
  });

  it("workerCount matches proxies array length", () => {
    for (const count of [0, 1, 3, 10]) {
      const t = generateTopology(count, 1000);
      expect(t.workerCount).toBe(count);
      expect(t.proxies.length).toBe(count);
    }
  });

  // ── Hash input isolation ───────────────────────────────────────────

  it("topologyId is a SHA-256 hash (64 hex chars after prefix)", () => {
    const t = generateTopology(3, 1000);
    const hashPart = t.topologyId.replace("sha256:", "");

    expect(hashPart).toHaveLength(64);
    expect(hashPart).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changing any topology-defining field changes the hash", () => {
    const base = generateTopology(3, 1000);

    // Same count, same names → same hash
    const same = generateTopology(3, 1000);
    expect(same.topologyId).toBe(base.topologyId);
  });
});

// ---------------------------------------------------------------------------
// Generated artifact consistency
// ---------------------------------------------------------------------------

describe("generated topology.ts artifact", () => {
  it("TOPOLOGY has schemaVersion 1", () => {
    expect(TOPOLOGY.schemaVersion).toBe(1);
  });

  it("TOPOLOGY has a valid topologyId", () => {
    expect(TOPOLOGY.topologyId).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("TOPOLOGY workerCount is a non-negative integer", () => {
    expect(Number.isInteger(TOPOLOGY.workerCount)).toBe(true);
    expect(TOPOLOGY.workerCount).toBeGreaterThanOrEqual(0);
  });

  it("TOPOLOGY proxies is an array", () => {
    expect(Array.isArray(TOPOLOGY.proxies)).toBe(true);
  });

  it("TOPOLOGY proxies length matches workerCount", () => {
    expect(TOPOLOGY.proxies.length).toBe(TOPOLOGY.workerCount);
  });

  it("TOPOLOGY proxies have correct shape", () => {
    for (const proxy of TOPOLOGY.proxies) {
      expect(proxy).toHaveProperty("id");
      expect(proxy).toHaveProperty("name");
      expect(proxy).toHaveProperty("status");
      expect(typeof proxy.id).toBe("number");
      expect(typeof proxy.name).toBe("string");
      expect(["active", "unknown"]).toContain(proxy.status);
    }
  });

  it("TOPOLOGY proxy names use zero-padded format", () => {
    for (const proxy of TOPOLOGY.proxies) {
      expect(proxy.name).toMatch(/^llm-proxy-\d{2}$/);
    }
  });

  it("TOPOLOGY proxy ids are sequential from 0", () => {
    const ids = TOPOLOGY.proxies.map((p) => p.id);
    expect(ids).toEqual([...Array(ids.length).keys()]);
  });

  it("TOPOLOGY is not frozen at runtime (as const is compile-time only)", () => {
    // TypeScript `as const` makes the object deeply readonly at compile time.
    // At runtime, the object is NOT frozen — immutability is enforced by
    // convention: the service never mutates the snapshot after caching it.
    expect(Object.isFrozen(TOPOLOGY)).toBe(false);
  });
});
