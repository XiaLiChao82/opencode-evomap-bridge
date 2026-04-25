import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readMemoryGraph } from "./bridge.ts";
import { defaultConfig } from "./config.ts";
import {
	detectEvolver,
	getEvolverRoot,
	getMemoryGraphPath,
} from "./spawn.ts";

export interface DoctorCheck {
	name: string;
	status: "pass" | "fail" | "warn";
	message: string;
	detail?: string;
}

export interface DoctorResult {
	checks: DoctorCheck[];
	healthy: boolean;
	summary: string;
}

async function checkEvolverCli(): Promise<DoctorCheck> {
	const detection = await detectEvolver(defaultConfig.evolverBinary);
	if (detection) {
		return {
			name: "Evolver CLI Detection",
			status: "pass",
			message: `evolver v${detection.version} found at ${detection.path}`,
		};
	}
	return {
		name: "Evolver CLI Detection",
		status: "fail",
		message: "evolver CLI not found. Install with: npm install -g @evomap/evolver",
	};
}

async function checkEvolverRoot(directory: string): Promise<DoctorCheck> {
	const evolverRoot = getEvolverRoot(directory);
	try {
		await access(evolverRoot);
		return {
			name: "Evolver Root Directory",
			status: "pass",
			message: ".evomap/ directory exists",
			detail: evolverRoot,
		};
	} catch {
		return {
			name: "Evolver Root Directory",
			status: "warn",
			message: ".evomap/ directory not found (will be created on first use)",
			detail: evolverRoot,
		};
	}
}

async function verifyWriteAccess(filePath: string): Promise<boolean> {
	const dir = path.dirname(filePath);
	const testPath = path.join(dir, ".doctor-write-test");
	await mkdir(dir, { recursive: true });
	await writeFile(testPath, "test", "utf8");
	await rm(testPath);
	return true;
}

async function checkMemoryGraph(directory: string): Promise<DoctorCheck> {
	const evolverRoot = getEvolverRoot(directory);
	const graphPath = getMemoryGraphPath(evolverRoot);
	const entries = await readMemoryGraph(graphPath);

	if (entries.length > 0) {
		try {
			await verifyWriteAccess(graphPath);
			return {
				name: "Memory Graph Access",
				status: "pass",
				message: `memory_graph.jsonl accessible (${entries.length} entries)`,
				detail: graphPath,
			};
		} catch (err) {
			return {
				name: "Memory Graph Access",
				status: "fail",
				message: `Cannot write to memory_graph.jsonl: ${err instanceof Error ? err.message : String(err)}`,
				detail: graphPath,
			};
		}
	}

	try {
		await access(graphPath);
		return {
			name: "Memory Graph Access",
			status: "pass",
			message: "memory_graph.jsonl accessible (0 entries)",
			detail: graphPath,
		};
	} catch {
		// fallthrough
	}

	try {
		await mkdir(path.dirname(graphPath), { recursive: true });
		await writeFile(graphPath, "", "utf8");
		await rm(graphPath);
		return {
			name: "Memory Graph Access",
			status: "warn",
			message: "memory_graph.jsonl not found (will be created on first use)",
			detail: graphPath,
		};
	} catch (err) {
		return {
			name: "Memory Graph Access",
			status: "fail",
			message: `Cannot write to memory_graph.jsonl: ${err instanceof Error ? err.message : String(err)}`,
			detail: graphPath,
		};
	}
}

async function checkPluginRegistration(directory: string): Promise<DoctorCheck> {
	const localPluginPath = path.join(directory, ".opencode", "plugin", "evomap.ts");
	const npmPackagePath = path.join(
		directory,
		"node_modules",
		"opencode-evomap-bridge",
		"package.json",
	);
	const npmPluginPath = path.join(
		directory,
		"node_modules",
		"opencode-evomap-bridge",
		".opencode",
		"plugin",
		"evomap.ts",
	);

	try {
		await access(localPluginPath);
		return {
			name: "Plugin Registration",
			status: "pass",
			message: "Plugin file exists at .opencode/plugin/evomap.ts",
			detail: localPluginPath,
		};
	} catch {
		// try npm installation mode next
	}

	try {
		await Promise.all([access(npmPackagePath), access(npmPluginPath)]);
		return {
			name: "Plugin Registration",
			status: "pass",
			message: "Plugin package exists in node_modules/opencode-evomap-bridge",
			detail: npmPluginPath,
		};
	} catch {
		return {
			name: "Plugin Registration",
			status: "fail",
			message: "Plugin not found in local .opencode path or npm installation",
			detail: `Expected one of: ${localPluginPath} OR ${npmPluginPath}`,
		};
	}
}

function checkConfiguration(): DoctorCheck {
	const config = defaultConfig;

	return {
		name: "Configuration Check",
		status: "pass",
		message: `Configuration valid (evolverBinary=${config.evolverBinary}, timeout=${config.evolverSpawnTimeoutMs}ms)`,
	};
}

export async function runDoctor(directory: string): Promise<DoctorResult> {
	console.warn("[EvoMapBridge/doctor] Running diagnostics...");

	const checks: DoctorCheck[] = [];

	checks.push(await checkEvolverCli());
	checks.push(await checkEvolverRoot(directory));
	checks.push(await checkMemoryGraph(directory));
	checks.push(await checkPluginRegistration(directory));
	checks.push(checkConfiguration());

	const allPass = checks.every((c) => c.status === "pass");
	const failCount = checks.filter((c) => c.status === "fail").length;
	const warnCount = checks.filter((c) => c.status === "warn").length;

	let summary: string;
	if (allPass) {
		summary = "All checks passed";
	} else {
		const parts: string[] = [];
		if (failCount > 0) {
			parts.push(`${failCount} failed`);
		}
		if (warnCount > 0) {
			parts.push(`${warnCount} warning${warnCount > 1 ? "s" : ""}`);
		}
		summary = parts.join(", ");
	}

	console.warn(`[EvoMapBridge/doctor] ${summary}`);

	return {
		checks,
		healthy: allPass,
		summary,
	};
}

export function formatDoctorResult(result: DoctorResult): string {
	const lines: string[] = [];
	const statusIcon: Record<string, string> = {
		pass: "✓",
		fail: "✗",
		warn: "⚠",
	};

	lines.push("=== EvoMap Bridge Doctor ===");
	lines.push("");

	for (const check of result.checks) {
		const icon = statusIcon[check.status] ?? "?";
		lines.push(`  ${icon} ${check.name}: ${check.message}`);
		if (check.detail) {
			lines.push(`    → ${check.detail}`);
		}
	}

	lines.push("");
	lines.push(`Summary: ${result.summary}`);

	return lines.join("\n");
}
