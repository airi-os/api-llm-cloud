import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleProxyRequest } from "../../src/proxy";
import { generateFakeIp } from "../../src/fake-ip";

vi.mock("../../src/fake-ip.ts", () => ({
  generateFakeIp: vi.fn(),
}));

const mockGenerateFakeIp = vi.mocked(generateFakeIp);

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    INTERNAL_AUTH_SECRET: "test-secret",
    PROXY_INDEX: "3",
    ...overrides,
  } as unknown as Env;
}

function makeRequest(overrides: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const headers = new Headers(overrides.headers ?? {});
  return new Request(overrides.url ?? "http://proxy/internal", {
    method: overrides.method ?? "POST",
    headers,
    body: overrides.body ?? '{"model":"gpt-4","messages":[]}',
  });
}

beforeEach(() => {
  mockGenerateFakeIp.mockResolvedValue("10.20.30.40");
});

describe("handleProxyRequest", () => {
  it("returns 401 if X-Internal-Auth header is missing", async () => {
    const req = makeRequest({
      headers: { "X-Target-URL": "https://api.openai.com/v1/chat/completions" },
    });
    const res = await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 if X-Internal-Auth header is wrong", async () => {
    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "wrong-secret",
        "X-Target-URL": "https://api.openai.com/v1/chat/completions",
      },
    });
    const res = await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it("returns 400 if X-Target-URL header is missing", async () => {
    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Original-Method": "POST",
      },
    });
    const res = await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Missing X-Target-URL header" });
  });

  it("returns 400 if X-Target-URL is empty", async () => {
    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "",
        "X-Original-Method": "POST",
      },
    });
    const res = await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it("forwards request to X-Target-URL using X-Original-Method", async () => {
    const upstreamBody = JSON.stringify({ choices: [{ text: "hello" }] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(upstreamBody, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.openai.com/v1/chat/completions",
        "X-Original-Method": "POST",
        Authorization: "Bearer sk-test-key",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    const res = await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [targetUrl, fetchOptions] = fetchSpy.mock.calls[0];
    expect(targetUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetchOptions.method).toBe("POST");

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody).toEqual({ choices: [{ text: "hello" }] });

    fetchSpy.mockRestore();
  });

  it("defaults to GET if X-Original-Method is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.openai.com/models",
      },
    });

    await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);

    expect(fetchSpy.mock.calls[0][1].method).toBe("GET");

    fetchSpy.mockRestore();
  });

  it("passes through Authorization, Content-Type, Accept headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.openai.com/v1/chat/completions",
        "X-Original-Method": "POST",
        Authorization: "Bearer sk-abc123",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
    });

    await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);

    const upstreamHeaders = fetchSpy.mock.calls[0][1].headers as Headers;
    expect(upstreamHeaders.get("Authorization")).toBe("Bearer sk-abc123");
    expect(upstreamHeaders.get("Content-Type")).toBe("application/json");
    expect(upstreamHeaders.get("Accept")).toBe("text/event-stream");

    fetchSpy.mockRestore();
  });

  it("strips CF-Connecting-IP, CF-RAY, CF-Visitor, CF-IPCountry, X-Real-IP, Host from original", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.anthropic.com/v1/messages",
        "X-Original-Method": "POST",
        "CF-Connecting-IP": "1.2.3.4",
        "CF-RAY": "some-ray-id",
        "CF-Visitor": '{"scheme":"https"}',
        "CF-IPCountry": "US",
        "X-Real-IP": "5.6.7.8",
        Host: "original-host.example.com",
      },
    });

    await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);

    const upstreamHeaders = fetchSpy.mock.calls[0][1].headers as Headers;
    expect(upstreamHeaders.get("CF-Connecting-IP")).toBeNull();
    expect(upstreamHeaders.get("CF-RAY")).toBeNull();
    expect(upstreamHeaders.get("CF-Visitor")).toBeNull();
    expect(upstreamHeaders.get("CF-IPCountry")).toBeNull();
    expect(upstreamHeaders.get("X-Real-IP")).toBeNull();
    expect(upstreamHeaders.get("Host")).toBe("api.anthropic.com");

    fetchSpy.mockRestore();
  });

  it("sets X-Forwarded-For to the deterministic fake IP based on PROXY_INDEX + target domain", async () => {
    mockGenerateFakeIp.mockResolvedValue("42.42.42.42");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.anthropic.com/v1/messages",
        "X-Original-Method": "POST",
      },
    });

    await handleProxyRequest(req, makeEnv({ PROXY_INDEX: "7" }), {} as ExecutionContext);

    expect(mockGenerateFakeIp).toHaveBeenCalledWith(7, "api.anthropic.com");

    const upstreamHeaders = fetchSpy.mock.calls[0][1].headers as Headers;
    expect(upstreamHeaders.get("X-Forwarded-For")).toBe("42.42.42.42");

    fetchSpy.mockRestore();
  });

  it("sets Host header to target domain", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.openai.com/v1/models",
        "X-Original-Method": "GET",
      },
    });

    await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);

    const upstreamHeaders = fetchSpy.mock.calls[0][1].headers as Headers;
    expect(upstreamHeaders.get("Host")).toBe("api.openai.com");

    fetchSpy.mockRestore();
  });

  it("passes body through untouched", async () => {
    const requestBody = '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}';
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const req = makeRequest({
      method: "POST",
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.openai.com/v1/chat/completions",
        "X-Original-Method": "POST",
      },
      body: requestBody,
    });

    await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);

    expect(fetchSpy.mock.calls[0][1].body).toBe(requestBody);

    fetchSpy.mockRestore();
  });

  it("returns upstream response as-is with CORS headers added", async () => {
    const upstreamHeaders = new Headers({
      "Content-Type": "application/json",
      "X-Request-Id": "req-123",
    });
    const upstreamBody = JSON.stringify({ id: "chatcmpl-abc", choices: [] });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(upstreamBody, { status: 200, headers: upstreamHeaders }),
    );

    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.openai.com/v1/chat/completions",
        "X-Original-Method": "POST",
      },
    });

    const res = await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Request-Id")).toBe("req-123");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = await res.json();
    expect(body).toEqual({ id: "chatcmpl-abc", choices: [] });

    fetchSpy.mockRestore();
  });

  it("returns 502 if upstream fetch throws an error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connection refused"),
    );

    const req = makeRequest({
      headers: {
        "X-Internal-Auth": "test-secret",
        "X-Target-URL": "https://api.openai.com/v1/chat/completions",
        "X-Original-Method": "POST",
      },
    });

    const res = await handleProxyRequest(req, makeEnv(), {} as ExecutionContext);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: "Upstream request failed" });

    fetchSpy.mockRestore();
  });
});
