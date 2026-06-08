import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

const DIST_DIR = path.join(projectRoot, "dist");

const DEFAULT_PROXY_COUNT = 3;
const WORKER_NAME_PREFIX = "llm-proxy-";
const WORKER_NAME_PAD = 2;

const DEPLOY_CONFIG = {
	maxRetries: 3,
	baseDelayMs: 2000,
	staggerDelayMs: 1000,
} as const;

interface WorkerConfig {
	name: string;
	configPath: string;
	type: "proxy" | "router";
}

interface DeployResult {
	worker: WorkerConfig;
	success: boolean;
	attempts: number;
	error?: string;
	durationMs: number;
}

// --- Env validation ---

function loadEnv() {
	const envPath = path.join(projectRoot, ".env");
	if (!fs.existsSync(envPath)) {
		console.error("❌ .env file not found. Copy .env.example to .env and fill in values.");
		process.exit(1);
	}

	const content = fs.readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
		if (!process.env[key]) {
			process.env[key] = val;
		}
	}
}

function requireEnv(name: string, minLen: number): string {
	const val = process.env[name];
	if (!val) {
		console.error(`❌ ${name} not set in .env`);
		process.exit(1);
	}
	if (val.length < minLen) {
		console.error(`❌ ${name} must be at least ${minLen} characters`);
		process.exit(1);
	}
	return val;
}

// --- TOML generation (no dependency) ---

function tomlStringify(obj: Record<string, unknown>, indent: string = ""): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null) continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "object" && item !== null) {
					lines.push(`${indent}[[${key}]]`);
					for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
						if (v === undefined || v === null) continue;
						lines.push(`${indent}${k} = ${tomlValue(v)}`);
					}
				} else {
					lines.push(`${indent}${key} = ${tomlValue(item)}`);
				}
			}
		} else if (typeof value === "object" && value !== null) {
			lines.push(`${indent}[${key}]`);
			lines.push(tomlStringify(value as Record<string, unknown>, indent));
		} else {
			lines.push(`${indent}${key} = ${tomlValue(value)}`);
		}
	}

	return lines.join("\n");
}

function tomlValue(value: unknown): string {
	if (typeof value === "string") return `"${value}"`;
	if (typeof value === "number") return value.toString();
	if (typeof value === "boolean") return value.toString();
	return `"${String(value)}"`;
}

// --- Config generation ---

function generateProxyToml(index: number, internalSecret: string): string {
	const name = `${WORKER_NAME_PREFIX}${String(index).padStart(WORKER_NAME_PAD, "0")}`;

	const config: Record<string, unknown> = {
		name,
		main: "../src/worker.ts",
		compatibility_date: "2024-12-01",
		placement: { mode: "off" },
		vars: {
			WORKER_ROLE: "proxy",
			PROXY_INDEX: String(index),
			INTERNAL_AUTH_SECRET: internalSecret,
		},
	};

	return tomlStringify(config);
}

function generateRouterToml(proxyCount: number, internalSecret: string, authKey: string): string {
	const services: Record<string, unknown>[] = [];
	for (let i = 1; i <= proxyCount; i++) {
		services.push({
			binding: `PROXY_${i}`,
			service: `${WORKER_NAME_PREFIX}${String(i).padStart(WORKER_NAME_PAD, "0")}`,
		});
	}

	const config: Record<string, unknown> = {
		name: "llm-proxy-router",
		main: "../src/worker.ts",
		compatibility_date: "2024-12-01",
		placement: { mode: "smart" },
		vars: {
			WORKER_ROLE: "router",
			AUTH_KEY: authKey,
			INTERNAL_AUTH_SECRET: internalSecret,
			PROXY_COUNT: String(proxyCount),
		},
		services,
	};

	return tomlStringify(config);
}

// --- Deploy ---

function runWranglerDeploy(configPath: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
	const configRel = path.relative(projectRoot, configPath);
	const cmd = `npx wrangler deploy -c ${configRel}`;

	return new Promise((resolve) => {
		const proc = spawn(cmd, { cwd: projectRoot, shell: true, stdio: "pipe" });
		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		proc.on("close", (code) => {
			resolve({
				success: code === 0,
				stdout,
				stderr: code === 0 ? "" : stderr || stdout,
			});
		});
	});
}

async function deployWithRetry(worker: WorkerConfig): Promise<DeployResult> {
	const start = Date.now();
	let lastError = "";

	for (let attempt = 1; attempt <= DEPLOY_CONFIG.maxRetries; attempt++) {
		console.log(`   🔄 ${worker.name} (attempt ${attempt})...`);
		const result = await runWranglerDeploy(worker.configPath);

		if (result.success) {
			return { worker, success: true, attempts: attempt, durationMs: Date.now() - start };
		}

		lastError = result.stderr;

		if (attempt < DEPLOY_CONFIG.maxRetries) {
			const delay = DEPLOY_CONFIG.baseDelayMs * 2 ** (attempt - 1);
			console.log(`   ⚠️  ${worker.name} failed, retrying in ${delay}ms...`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}

	return { worker, success: false, attempts: DEPLOY_CONFIG.maxRetries, error: lastError, durationMs: Date.now() - start };
}

async function deployParallel(workers: WorkerConfig[]): Promise<DeployResult[]> {
	const tasks = workers.map((worker, index) =>
		(async () => {
			await new Promise((r) => setTimeout(r, index * DEPLOY_CONFIG.staggerDelayMs));
			return deployWithRetry(worker);
		})(),
	);
	return Promise.all(tasks);
}

function printSummary(results: DeployResult[], totalStart: number): void {
	const succeeded = results.filter((r) => r.success).length;
	const totalMs = Date.now() - totalStart;

	console.log("\n┌─────────────────────────────────────────────┐");
	console.log("│ Deploy Summary                              │");
	console.log("├─────────────────────────────────────────────┤");

	for (const r of results) {
		const status = r.success ? "✅" : "❌";
		const name = r.worker.name.padEnd(20);
		const attempts = r.success
			? `(${r.attempts} attempt${r.attempts > 1 ? "s" : ""}, ${(r.durationMs / 1000).toFixed(1)}s)`
			: `(${r.attempts} attempts)`;

		console.log(`│ ${status} ${name} ${attempts.padEnd(20)} │`);

		if (!r.success && r.error) {
			const errorLine = r.error.split("\n")[0].slice(0, 40);
			console.log(`│    Error: ${errorLine.padEnd(32)} │`);
		}
	}

	console.log("├─────────────────────────────────────────────┤");
	console.log(`${`│ Total: ${succeeded}/${results.length} succeeded in ${(totalMs / 1000).toFixed(1)}s`.padEnd(46)}│`);
	console.log("└─────────────────────────────────────────────┘");
}

// --- Main ---

async function main() {
	loadEnv();

	const authKey = requireEnv("AUTH_KEY", 8);
	const internalSecret = requireEnv("INTERNAL_AUTH_SECRET", 32);
	const proxyCount = Number(process.env.PROXY_COUNT) || DEFAULT_PROXY_COUNT;

	console.log(`🚀 Deploying ${proxyCount} proxies + router`);

	if (!fs.existsSync(DIST_DIR)) {
		fs.mkdirSync(DIST_DIR, { recursive: true });
	}

	const totalStart = Date.now();
	const allResults: DeployResult[] = [];

	// Generate and deploy proxy workers
	const proxyWorkers: WorkerConfig[] = [];
	for (let i = 1; i <= proxyCount; i++) {
		const toml = generateProxyToml(i, internalSecret);
		const configPath = path.join(DIST_DIR, `proxy-${String(i).padStart(2, "0")}.toml`);
		fs.writeFileSync(configPath, toml);
		proxyWorkers.push({ name: `${WORKER_NAME_PREFIX}${String(i).padStart(WORKER_NAME_PAD, "0")}`, configPath, type: "proxy" });
	}

	console.log("\n📦 Phase 1: Deploying proxies...");
	const proxyResults = await deployParallel(proxyWorkers);
	allResults.push(...proxyResults);

	const failedProxies = proxyResults.filter((r) => !r.success);
	if (failedProxies.length > 0) {
		console.error(`\n⚠️  ${failedProxies.length} proxies failed. Continuing to Router...`);
	}

	// Generate and deploy router
	const routerToml = generateRouterToml(proxyCount, internalSecret, authKey);
	const routerConfigPath = path.join(DIST_DIR, "router.toml");
	fs.writeFileSync(routerConfigPath, routerToml);
	const routerWorker: WorkerConfig = { name: "llm-proxy-router", configPath: routerConfigPath, type: "router" };

	console.log("\n📦 Phase 2: Deploying router...");
	const routerResult = await deployWithRetry(routerWorker);
	allResults.push(routerResult);

	// Summary
	printSummary(allResults, totalStart);

	const totalFailed = allResults.filter((r) => !r.success).length;
	if (totalFailed > 0) {
		process.exit(1);
	}

	console.log(`\n✅ All systems operational.`);
	console.log(`   Configs: ${DIST_DIR}`);
}

main().catch(console.error);
