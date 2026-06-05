import { describe, it, expect } from "vitest";
import { generateFakeIp } from "../../src/fake-ip";

describe("generateFakeIp", () => {
  it("is deterministic: same inputs produce the same IP", async () => {
    const a = await generateFakeIp(1, "api.openai.com");
    const b = await generateFakeIp(1, "api.openai.com");
    expect(a).toBe(b);
  });

  it("different proxy index produces different IP", async () => {
    const a = await generateFakeIp(1, "api.openai.com");
    const b = await generateFakeIp(2, "api.openai.com");
    expect(a).not.toBe(b);
  });

  it("different domain produces different IP", async () => {
    const a = await generateFakeIp(1, "api.openai.com");
    const b = await generateFakeIp(1, "api.anthropic.com");
    expect(a).not.toBe(b);
  });

  it("returns valid IPv4 format", async () => {
    const ip = await generateFakeIp(0, "api.openai.com");
    const octets = ip.split(".");
    expect(octets).toHaveLength(4);
    for (const octet of octets) {
      const n = Number(octet);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(255);
      expect(octet).toBe(String(n));
    }
  });

  it("proxy 0 + api.openai.com produces fixed expected IP", async () => {
    const ip = await generateFakeIp(0, "api.openai.com");
    expect(ip).toBe("80.83.15.32");
  });
});
