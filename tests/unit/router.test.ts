import { describe, it, expect, vi } from "vitest";
import { handleRouterRequest } from "../../src/router";
import { encodeBase64Url } from "../../src/base64url";

function makeProxyBinding(response?: Response) {
  return {
    fetch: vi.fn().mockResolvedValue(
      response ?? new Response("ok", { status: 200 }),
    ),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_KEY: "test-auth-key",
    PROXY_COUNT: "3",
    PROXY_1: makeProxyBinding(),
    PROXY_2: makeProxyBinding(),
    PROXY_3: makeProxyBinding(),
    ...overrides,
  };
}

const encodedOpenAi = encodeBase64Url("https://api.openai.com/v1");
const encodedAnthropic = encodeBase64Url("https://api.anthropic.com/v1");

describe("handleRouterRequest", () => {
  it("returns 403 if PASS segment doesn't match AUTH_KEY", async () => {
    const req = new Request(
      `http://router/wrong-pass/1/${encodedOpenAi}/chat/completions`,
    );
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it("returns 400 if PROXY_NUM is not a valid integer", async () => {
    const req = new Request(
      `http://router/test-auth-key/abc/${encodedOpenAi}/chat/completions`,
    );
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it("returns 400 if BASE64_URL segment is invalid base64", async () => {
    const req = new Request(
      "http://router/test-auth-key/1/!!!invalid/chat/completions",
    );
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it("returns 400 if BASE64_URL doesn't decode to a valid URL", async () => {
    const notAUrl = encodeBase64Url("not-a-valid-url");
    const req = new Request(
      `http://router/test-auth-key/1/${notAUrl}/chat/completions`,
    );
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it("decodes BASE64_URL and constructs target URL with extra path", async () => {
    const env = makeEnv();
    const req = new Request(
      `http://router/test-auth-key/0/${encodedOpenAi}/chat/completions`,
      { method: "POST", body: '{"model":"gpt-4"}' },
    );
    await handleRouterRequest(req, env, {} as ExecutionContext);

    const proxy = env.PROXY_1 as { fetch: ReturnType<typeof vi.fn> };
    const forwarded = proxy.fetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("X-Target-URL")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("selects proxy by PROXY_NUM % PROXY_COUNT (0-based index → 1-based binding)", async () => {
    const env = makeEnv();
    const req = new Request(
      `http://router/test-auth-key/0/${encodedOpenAi}/chat/completions`,
    );
    await handleRouterRequest(req, env, {} as ExecutionContext);

    expect((env.PROXY_1 as { fetch: ReturnType<typeof vi.fn> }).fetch).toHaveBeenCalledTimes(1);
    expect((env.PROXY_2 as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
    expect((env.PROXY_3 as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
  });

  it("modulo wraps: PROXY_NUM=100 with 3 proxies → 100%3=1 → PROXY_2", async () => {
    const env = makeEnv();
    const req = new Request(
      `http://router/test-auth-key/100/${encodedOpenAi}/chat/completions`,
    );
    await handleRouterRequest(req, env, {} as ExecutionContext);

    expect((env.PROXY_1 as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
    expect((env.PROXY_2 as { fetch: ReturnType<typeof vi.fn> }).fetch).toHaveBeenCalledTimes(1);
    expect((env.PROXY_3 as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
  });

  it("forwards request with internal headers", async () => {
    const env = makeEnv();
    const req = new Request(
      `http://router/test-auth-key/1/${encodedOpenAi}/chat/completions`,
      { method: "POST" },
    );
    await handleRouterRequest(req, env, {} as ExecutionContext);

    const proxy = env.PROXY_2 as { fetch: ReturnType<typeof vi.fn> };
    const forwarded = proxy.fetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("X-Internal-Auth")).toBe("test-auth-key");
    expect(forwarded.headers.get("X-Target-URL")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(forwarded.headers.get("X-Original-Method")).toBe("POST");
  });

  it("passes through client body untouched", async () => {
    const env = makeEnv();
    const body = '{"model":"gpt-4","messages":[]}';
    const req = new Request(
      `http://router/test-auth-key/1/${encodedOpenAi}/chat/completions`,
      { method: "POST", body },
    );
    await handleRouterRequest(req, env, {} as ExecutionContext);

    const proxy = env.PROXY_2 as { fetch: ReturnType<typeof vi.fn> };
    const forwarded = proxy.fetch.mock.calls[0][0] as Request;
    expect(await forwarded.text()).toBe(body);
  });

  it("returns 502 if resolved proxy binding is undefined", async () => {
    const env = makeEnv({ PROXY_COUNT: "10" });
    // 5 % 10 = 5, 1-based = 6, PROXY_6 doesn't exist
    const req = new Request(
      `http://router/test-auth-key/5/${encodedOpenAi}/chat/completions`,
    );
    const res = await handleRouterRequest(req, env, {} as ExecutionContext);
    expect(res.status).toBe(502);
  });

  it("returns 204 for CORS preflight OPTIONS", async () => {
    const req = new Request("http://router/anything", { method: "OPTIONS" });
    const res = await handleRouterRequest(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns the proxy response to the client", async () => {
    const upstream = new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const env = makeEnv({ PROXY_1: makeProxyBinding(upstream) });
    const req = new Request(
      `http://router/test-auth-key/0/${encodedOpenAi}/chat/completions`,
    );
    const res = await handleRouterRequest(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [] });
  });
});
