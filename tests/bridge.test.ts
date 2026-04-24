import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendMemoryGraph,
	evolverEntryToObservation,
	memoryEntriesToObservations,
	readMemoryGraph,
	signalToEvolverEntry,
} from "../src/bridge.ts";
import {
	detectEvolver,
	getEvolverRoot,
	getMemoryGraphPath,
	isEvolverAvailable,
	spawnEvolver,
} from "../src/spawn.ts";
import type { EvolverMemoryEntry, RawToolSignal } from "../src/types.ts";

function makeSignal(overrides: Partial<RawToolSignal>): RawToolSignal {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		sessionId: overrides.sessionId ?? "session-1",
		projectId: overrides.projectId ?? "project-1",
		tool: overrides.tool ?? "bash",
		callId: overrides.callId ?? crypto.randomUUID(),
		createdAt: overrides.createdAt ?? new Date().toISOString(),
		args: overrides.args ?? { command: "bun test" },
		pathHints: overrides.pathHints ?? [],
		toolCategory: overrides.toolCategory ?? "execution",
		argsSummary: overrides.argsSummary ?? "bun test",
		sessionPhase: overrides.sessionPhase ?? "mid",
		failureKind: overrides.failureKind ?? "none",
		result: {
			success: overrides.result?.success ?? false,
			exitCode: overrides.result?.exitCode ?? 1,
			durationMs: overrides.result?.durationMs ?? 100,
			outputDigest: overrides.result?.outputDigest ?? "digest-1",
			errorSnippet: overrides.result?.errorSnippet ?? "Command failed",
		},
	};
}

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

// --- bridge.ts tests ---

describe("signalToEvolverEntry", () => {
	test("converts success signal to entry with success status", () => {
		const signal = makeSignal({
			result: {
				success: true,
				exitCode: 0,
				durationMs: 200,
				outputDigest: "ok",
				errorSnippet: "",
			},
		});
		const entry = signalToEvolverEntry(signal);
		expect(entry.outcome.status).toBe("success");
		expect(entry.outcome.score).toBeGreaterThanOrEqual(0.7);
		expect(entry.timestamp).toBe(signal.createdAt);
		expect(entry.source).toBe("opencode-bridge:mid");
		expect(entry.gene_id).toBe("execution:bash:none");
		expect(entry.signals).toContain("stable_success_plateau");
	});

	test("converts failure signal to entry with failed status and log_error signal", () => {
		const signal = makeSignal({
			result: {
				success: false,
				exitCode: 1,
				durationMs: 50,
				outputDigest: "err",
				errorSnippet: "Command failed",
			},
		});
		const entry = signalToEvolverEntry(signal);
		expect(entry.outcome.status).toBe("failed");
		expect(entry.outcome.score).toBeLessThanOrEqual(0.35);
		expect(entry.signals).toContain("log_error");
		expect(entry.outcome.note).toContain("failed");
		expect(entry.outcome.note).toContain("Command failed");
	});
});

describe("evolverEntryToObservation", () => {
	test("maps known evolver signals to ObservationType", () => {
		const entry = makeEvolverEntry({
			signals: ["repair_loop_detected"],
			outcome: { status: "failed", score: 0.15, note: "loop detected" },
		});
		const observation = evolverEntryToObservation(entry);
		expect(observation).not.toBeNull();
		expect(observation!.type).toBe("repeat_failure");
		expect(observation!.message).toBe("loop detected");
		expect(observation!.confidence).toBe(0.15);
		expect(observation!.tool).toBe("unknown");
		expect(observation!.source).toBe("evolver-log");
	});

	test("returns null for unknown signals", () => {
		const entry = makeEvolverEntry({
			signals: ["totally_unknown_signal_xyz"],
		});
		const observation = evolverEntryToObservation(entry);
		expect(observation).toBeNull();
	});
});

describe("memoryEntriesToObservations", () => {
	test("deduplicates entries by fingerprint", () => {
		const base = makeEvolverEntry({
			gene_id: "gene-dupe",
			timestamp: new Date().toISOString(),
			signals: ["repair_loop_detected"],
		});
		const entries = [
			base,
			{ ...base, timestamp: new Date(Date.now() + 1000).toISOString() },
		];
		const observations = memoryEntriesToObservations(entries);
		// Both entries share gene_id and signal type → same fingerprint
		expect(observations).toHaveLength(1);
	});
});

describe("appendMemoryGraph + readMemoryGraph", () => {
	test("round-trip write and read in temp dir", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const filePath = path.join(directory, "memory", "test_graph.jsonl");
			const entry = makeEvolverEntry({
				signals: ["perf_bottleneck"],
				outcome: { status: "neutral", score: 0.5, note: "slow call" },
			});

			await appendMemoryGraph(filePath, entry);
			const readBack = await readMemoryGraph(filePath);

			expect(readBack).toHaveLength(1);
			expect(readBack[0]!.gene_id).toBe(entry.gene_id);
			expect(readBack[0]!.signals).toEqual(entry.signals);
			expect(readBack[0]!.outcome.note).toBe("slow call");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("readMemoryGraph", () => {
	test("skips malformed lines gracefully", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const filePath = path.join(directory, "mixed.jsonl");
			const goodEntry = makeEvolverEntry({
				signals: ["stable_success_plateau"],
			});

			// Write mixed content: good, bad, empty line, bad, good
			const { appendFile, mkdir: mkdirFn } = await import(
				"node:fs/promises"
			);
			await mkdirFn(path.dirname(filePath), { recursive: true });
			await appendFile(
				filePath,
				JSON.stringify(goodEntry) +
					"\n{bad json\n\nnot-json-at-all\n" +
					JSON.stringify(goodEntry) +
					"\n",
				"utf8",
			);

			const entries = await readMemoryGraph(filePath);
			expect(entries).toHaveLength(2);
			expect(entries[0]!.gene_id).toBe(goodEntry.gene_id);
			expect(entries[1]!.gene_id).toBe(goodEntry.gene_id);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

// --- spawn.ts tests ---

describe("getEvolverRoot", () => {
	test("returns directory with .evomap suffix", () => {
		expect(getEvolverRoot("/tmp/project")).toBe("/tmp/project/.evomap");
	});
});

describe("getMemoryGraphPath", () => {
	test("returns correct subpath", () => {
		const root = "/tmp/project/.evomap";
		expect(getMemoryGraphPath(root)).toBe(
			"/tmp/project/.evomap/memory/evolution/memory_graph.jsonl",
		);
	});
});

describe("isEvolverAvailable", () => {
	test.skip("requires evolver installed", async () => {
		await isEvolverAvailable();
	});
});

describe("detectEvolver", () => {
	test.skip("requires evolver installed", async () => {
		await detectEvolver();
	});
});

describe("spawnEvolver", () => {
	test("returns structured metadata for successful execution", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-spawn-"));
		try {
			const binDir = path.join(directory, "bin");
			await mkdir(binDir, { recursive: true });
			await writeFile(
				path.join(binDir, "evolver"),
				"#!/bin/sh\necho success\nexit 0\n",
				"utf8",
			);
			await chmod(path.join(binDir, "evolver"), 0o755);

			const result = await spawnEvolver({
				command: "run",
				cwd: directory,
				timeoutMs: 500,
				env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
			});

			expect(result.exitCode).toBe(0);
			expect(result.timedOut).toBe(false);
			expect(result.stdout.trim()).toBe("success");
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(result.attempt).toBe(1);
			expect(result.startedAt.length).toBeGreaterThan(0);
			expect(result.finishedAt.length).toBeGreaterThan(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("marks timed out executions", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-spawn-"));
		try {
			const binDir = path.join(directory, "bin");
			await mkdir(binDir, { recursive: true });
			await writeFile(
				path.join(binDir, "evolver"),
				"#!/bin/sh\nsleep 1\nexit 0\n",
				"utf8",
			);
			await chmod(path.join(binDir, "evolver"), 0o755);

			const result = await spawnEvolver({
				command: "run",
				cwd: directory,
				timeoutMs: 50,
				env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
			});

			expect(result.timedOut).toBe(true);
			expect(result.exitCode).toBeNull();
			expect(result.attempt).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("retries failed executions and succeeds on second attempt", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-spawn-"));
		try {
			const binDir = path.join(directory, "bin");
			await mkdir(binDir, { recursive: true });
			await writeFile(
				path.join(binDir, "evolver"),
				"#!/bin/sh\nif [ -f .retry-ok ]; then\n  echo success\n  exit 0\nfi\ntouch .retry-ok\necho first-fail >&2\nexit 1\n",
				"utf8",
			);
			await chmod(path.join(binDir, "evolver"), 0o755);

			const result = await spawnEvolver({
				command: "run",
				cwd: directory,
				timeoutMs: 500,
				retries: 1,
				retryDelayMs: 10,
				env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
			});

			expect(result.exitCode).toBe(0);
			expect(result.timedOut).toBe(false);
			expect(result.attempt).toBe(2);
			expect(result.stdout.trim()).toBe("success");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("returns structured failure when spawn cannot execute", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-spawn-"));
		try {
			const result = await spawnEvolver({
				command: "run",
				cwd: directory,
				timeoutMs: 100,
				env: { PATH: "/definitely-missing-path" },
			});

			expect(result.exitCode).toBeNull();
			expect(result.timedOut).toBe(false);
			expect(result.stderr.length).toBeGreaterThan(0);
			expect(result.attempt).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
