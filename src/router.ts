import { decodeBase64Url } from "./base64url";
import { corsResponse, errorResponse } from "./http";

export async function handleRouterRequest(
  request: Request,
  env: { AUTH_KEY: string; PROXY_COUNT: string; [key: string]: unknown },
  _ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return corsResponse();
  }

  const url = new URL(request.url);
  const segments = url.pathname.split("/");
  const pass = segments[1];
  if (pass !== env.AUTH_KEY) {
    return errorResponse("Forbidden", 403);
  }

  const proxyNumRaw = segments[2];
  if (!proxyNumRaw) {
    return errorResponse("Invalid PROXY_NUM", 400);
  }
  const proxyNum = Number(proxyNumRaw);
  if (!Number.isInteger(proxyNum)) {
    return errorResponse("Invalid PROXY_NUM", 400);
  }

  const encodedUrl = segments[3];
  if (!encodedUrl) {
    return errorResponse("Missing BASE64_URL", 400);
  }
  let decodedUrl: string;
  try {
    decodedUrl = decodeBase64Url(encodedUrl);
  } catch {
    return errorResponse("Invalid BASE64_URL", 400);
  }
  try {
    new URL(decodedUrl);
  } catch {
    return errorResponse("Invalid target URL", 400);
  }

  const extraPath = segments.slice(4).join("/");
  const targetUrl = decodedUrl + "/" + extraPath;

  const proxyCount = Number(env.PROXY_COUNT);
  const proxyIndex = proxyNum % proxyCount;
  const bindingName = `PROXY_${proxyIndex + 1}`;

  const proxyBinding = env[bindingName] as
    | { fetch: (req: Request) => Promise<Response> }
    | undefined;
  if (!proxyBinding) {
    return errorResponse("Proxy not found", 502);
  }

  const method = request.method;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.text();

  const headers = new Headers();
  headers.set("X-Internal-Auth", env.AUTH_KEY);
  headers.set("X-Target-URL", targetUrl);
  headers.set("X-Original-Method", method);

  const proxyRequest = new Request("http://internal", {
    method,
    headers,
    body,
  });

  return proxyBinding.fetch(proxyRequest);
}
