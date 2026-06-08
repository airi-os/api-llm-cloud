import { decodeBase64Url } from "./base64url";
import { corsResponse, errorResponse, filterPassthroughHeaders, jsonResponse } from "./http";
import { publicPage } from "./public";

const WORKER_NAME_PREFIX = "llm-proxy-";
const WORKER_NAME_PAD = 2;

async function sha256Hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function generateTopology(proxyCount: number) {
	const proxies = Array.from({ length: proxyCount }, (_, i) => ({
		id: i,
		name: `${WORKER_NAME_PREFIX}${String(i).padStart(WORKER_NAME_PAD, "0")}`,
		status: "active" as const,
	}));

	const topologyGeneratedAt = Math.floor(Date.now() / 1000);

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

export async function handleRouterRequest(
	request: Request,
	env: { AUTH_KEY: string; PROXY_COUNT: string; INTERNAL_AUTH_SECRET: string; [key: string]: unknown },
	_ctx: ExecutionContext,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return corsResponse();
	}

	const url = new URL(request.url);

	// Internal topology endpoint (before auth check for client requests)
	if (request.method === "GET" && url.pathname === "/internal/v1/topology") {
		const authHeader = request.headers.get("X-Internal-Auth");
		if (authHeader !== env.INTERNAL_AUTH_SECRET) {
			return errorResponse("Unauthorized", 401);
		}
		const proxyCount = Number(env.PROXY_COUNT);
		const topology = await generateTopology(proxyCount);
		return jsonResponse(topology);
	}

	const segments = url.pathname.split("/");

	const pass = segments[1];
	if (pass !== env.AUTH_KEY) {
		return errorResponse("Forbidden", 403);
	}

	if (request.method === "GET" && !segments[2]) {
		return publicPage(url.hostname, env.AUTH_KEY);
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

	const decodedUrlClean = decodedUrl.replace(/\/+$/, "");
	const extraPath = segments.slice(4).join("/");
	const targetUrl = extraPath ? `${decodedUrlClean}/${extraPath}` : decodedUrlClean;

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

	const headers = filterPassthroughHeaders(request.headers);
	headers.set("X-Internal-Auth", env.INTERNAL_AUTH_SECRET as string);
	headers.set("X-Target-URL", targetUrl);
	headers.set("X-Original-Method", method);

	const proxyRequest = new Request("http://internal", {
		method,
		headers,
		body,
	});

	return proxyBinding.fetch(proxyRequest);
}
