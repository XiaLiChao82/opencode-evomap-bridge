import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	formatDoctorResult,
	runDoctor,
} from "../src/doctor.ts";
import type { DoctorCheck, DoctorResult } from "../src/doctor.ts";
import { appendMemoryGraph } from "../src/bridge.ts";
import type { EvolverMemoryEntry } from "../src/types.ts";

function makeEvolverEntry(
	overrides: Partial<EvolverMemoryEntry>,
): EvolverMemoryEntry {
	return {
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		gene_id: overrides.gene_id ?? "gene-1",
		signals: overrides.signals ?? ["repair_loop_detected"],
		outcome: overrides.outcome ?? {
			status: "failed",
			score: 0.2,
			note: "test failure",
		},
		source: overrides.source ?? "opencode-bridge:tool.after",
	};
}

describe("runDoctor", () => {
	test("returns result with all 5 expected checks", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const result = await runDoctor(directory);

			expect(result.checks).toHaveLength(5);
			expect(result).toHaveProperty("healthy");
			expect(result).toHaveProperty("summary");
			expect(typeof result.healthy).toBe("boolean");
			expect(typeof result.summary).toBe("string");

			const names = result.checks.map((c) => c.name);
			expect(names).toContain("Evolver CLI Detection");
			expect(names).toContain("Evolver Root Directory");
			expect(names).toContain("Memory Graph Access");
			expect(names).toContain("Plugin Registration");
			expect(names).toContain("Configuration Check");

			for (const check of result.checks) {
				expect(["pass", "fail", "warn"]).toContain(check.status);
				expect(check.message.length).toBeGreaterThan(0);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("evolver root warns when .evomap/ missing", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const result = await runDoctor(directory);
			const rootCheck = result.checks.find(
				(c) => c.name === "Evolver Root Directory",
			);
			expect(rootCheck).toBeDefined();
			expect(rootCheck!.status).toBe("warn");
			expect(rootCheck!.message).toContain(".evomap/");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("evolver root passes when .evomap/ exists", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			await mkdir(path.join(directory, ".evomap"));
			const result = await runDoctor(directory);
			const rootCheck = result.checks.find(
				(c) => c.name === "Evolver Root Directory",
			);
			expect(rootCheck).toBeDefined();
			expect(rootCheck!.status).toBe("pass");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("plugin registration fails when plugin file absent", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const result = await runDoctor(directory);
			const pluginCheck = result.checks.find(
				(c) => c.name === "Plugin Registration",
			);
			expect(pluginCheck).toBeDefined();
			expect(pluginCheck!.status).toBe("fail");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("plugin registration passes when plugin file exists", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const pluginDir = path.join(directory, ".opencode", "plugin");
			await mkdir(pluginDir, { recursive: true });
			await writeFile(
				path.join(pluginDir, "evomap.ts"),
				"export default {};",
				"utf8",
			);
			const result = await runDoctor(directory);
			const pluginCheck = result.checks.find(
				(c) => c.name === "Plugin Registration",
			);
			expect(pluginCheck).toBeDefined();
			expect(pluginCheck!.status).toBe("pass");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("plugin registration passes when plugin is installed from npm", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const packageDir = path.join(
				directory,
				"node_modules",
				"opencode-evomap-bridge",
			);
			const pluginDir = path.join(packageDir, ".opencode", "plugin");
			await mkdir(pluginDir, { recursive: true });
			await writeFile(
				path.join(packageDir, "package.json"),
				JSON.stringify({
					name: "opencode-evomap-bridge",
					main: "./.opencode/plugin/evomap.ts",
				}),
				"utf8",
			);
			await writeFile(
				path.join(pluginDir, "evomap.ts"),
				"export default {};",
				"utf8",
			);

			const result = await runDoctor(directory);
			const pluginCheck = result.checks.find(
				(c) => c.name === "Plugin Registration",
			);
			expect(pluginCheck).toBeDefined();
			expect(pluginCheck!.status).toBe("pass");
			expect(pluginCheck!.message).toContain("node_modules/opencode-evomap-bridge");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("memory graph warns when file absent", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const result = await runDoctor(directory);
			const memCheck = result.checks.find(
				(c) => c.name === "Memory Graph Access",
			);
			expect(memCheck).toBeDefined();
			expect(memCheck!.status).toBe("warn");
			expect(memCheck!.message).toContain("not found");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("memory graph passes with existing entries", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const graphDir = path.join(
				directory,
				".evomap",
				"memory",
				"evolution",
			);
			await mkdir(graphDir, { recursive: true });
			const graphPath = path.join(graphDir, "memory_graph.jsonl");
			const entry = makeEvolverEntry({
				signals: ["repair_loop_detected"],
			});
			await appendMemoryGraph(graphPath, entry);

			const result = await runDoctor(directory);
			const memCheck = result.checks.find(
				(c) => c.name === "Memory Graph Access",
			);
			expect(memCheck).toBeDefined();
			expect(memCheck!.status).toBe("pass");
			expect(memCheck!.message).toContain("1 entries");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("configuration check passes with default config", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const result = await runDoctor(directory);
			const configCheck = result.checks.find(
				(c) => c.name === "Configuration Check",
			);
			expect(configCheck).toBeDefined();
			expect(configCheck!.status).toBe("pass");
			expect(configCheck!.message).toContain("evolverBinary=evolver");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("healthy is false when any check fails", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
		try {
			const result = await runDoctor(directory);
			expect(result.healthy).toBe(false);
			expect(result.summary.length).toBeGreaterThan(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("formatDoctorResult", () => {
	test("produces non-empty string output", () => {
		const result: DoctorResult = {
			checks: [
				{
					name: "Test Check",
					status: "pass",
					message: "all good",
					detail: "/some/path",
				},
			],
			healthy: true,
			summary: "All checks passed",
		};
		const formatted = formatDoctorResult(result);
		expect(formatted.length).toBeGreaterThan(0);
		expect(formatted).toContain("EvoMap Bridge Doctor");
		expect(formatted).toContain("Test Check");
		expect(formatted).toContain("all good");
		expect(formatted).toContain("/some/path");
		expect(formatted).toContain("All checks passed");
	});

	test("renders each status icon correctly", () => {
		const result: DoctorResult = {
			checks: [
				{ name: "A", status: "pass", message: "ok" },
				{ name: "B", status: "warn", message: "hmm" },
				{ name: "C", status: "fail", message: "bad" },
			],
			healthy: false,
			summary: "1 failed, 1 warning",
		};
		const formatted = formatDoctorResult(result);
		expect(formatted).toContain("✓ A: ok");
		expect(formatted).toContain("⚠ B: hmm");
		expect(formatted).toContain("✗ C: bad");
	});

	test("omits detail line when detail is undefined", () => {
		const result: DoctorResult = {
			checks: [
				{ name: "No Detail", status: "pass", message: "fine" },
			],
			healthy: true,
			summary: "All checks passed",
		};
		const formatted = formatDoctorResult(result);
		expect(formatted).not.toContain("→");
	});
});
