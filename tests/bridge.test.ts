import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendMemoryGraph,
	buildMemoryGraphEvent,
	evolverEntryToObservation,
	evolverGEPObservations,
	memoryGraphEventToJsonl,
	readMemoryGraph,
	signalToEvolverEntry,
} from "../src/bridge.ts";
import {
	detectEvolver,
	getEvolverRoot,
	getMemoryGraphPath,
	isEvolverAvailable,
} from "../src/spawn.ts";
import type { AppliedEvolverInstruction, EvolverMemoryEntry, RawToolSignal } from "../src/types.ts";

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
		expect(entry.source).toBe("opencode-bridge:tool.after");
		expect(entry.gene_id).toBe("ad_hoc");
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
	});

	test("returns null for unknown signals with neutral outcome", () => {
		const entry = makeEvolverEntry({
			signals: ["totally_unknown_signal_xyz"],
			outcome: { status: "neutral", score: 0.5, note: "neutral" },
		});
		const observation = evolverEntryToObservation(entry);
		expect(observation).toBeNull();
	});

	test("falls back to outcome status for unknown signals", () => {
		const entry = makeEvolverEntry({
			signals: ["totally_unknown_signal_xyz"],
			outcome: { status: "failed", score: 0.2, note: "fallback test" },
		});
		const observation = evolverEntryToObservation(entry);
		expect(observation).not.toBeNull();
		expect(observation!.type).toBe("repeat_failure");
	});

	test("matches signals by pattern", () => {
		const entry = makeEvolverEntry({
			signals: ["disk_error_sector_7"],
			outcome: { status: "neutral", score: 0.3, note: "pattern match" },
		});
		const observation = evolverEntryToObservation(entry);
		expect(observation).not.toBeNull();
		expect(observation!.type).toBe("repeat_failure");
	});
});

describe("evolverGEPObservations", () => {
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
		const observations = evolverGEPObservations(entries);
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

// --- MemoryGraphEvent adapter tests ---

describe("readMemoryGraph with MemoryGraphEvent format", () => {
	test("converts MemoryGraphEvent outcome entries to EvolverMemoryEntry", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const filePath = path.join(directory, "memory", "mge_graph.jsonl");
			const { appendFile, mkdir: mkdirFn } = await import("node:fs/promises");
			await mkdirFn(path.dirname(filePath), { recursive: true });

			const outcomeEvent = {
				type: "MemoryGraphEvent",
				kind: "outcome",
				id: "mge_test_001",
				ts: "2026-04-25T02:00:00.000Z",
				signal: {
					key: "memory_missing",
					signals: ["memory_missing", "user_missing"],
					error_signature: null,
				},
				outcome: {
					status: "success",
					score: 0.8,
					note: "stable_no_error",
				},
				gene: { id: "gene-test-1", category: "behavior" },
			};

			await appendFile(filePath, JSON.stringify(outcomeEvent) + "\n", "utf8");

			const entries = await readMemoryGraph(filePath);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.timestamp).toBe("2026-04-25T02:00:00.000Z");
			expect(entries[0]!.gene_id).toBe("gene-test-1");
			expect(entries[0]!.signals).toEqual(["memory_missing", "user_missing"]);
			expect(entries[0]!.outcome.status).toBe("success");
			expect(entries[0]!.outcome.score).toBe(0.8);
			expect(entries[0]!.source).toBe("evolver:outcome");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("skips MemoryGraphEvent entries without signals or outcome", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const filePath = path.join(directory, "memory", "mge_skip.jsonl");
			const { appendFile, mkdir: mkdirFn } = await import("node:fs/promises");
			await mkdirFn(path.dirname(filePath), { recursive: true });

			const hypothesisEvent = {
				type: "MemoryGraphEvent",
				kind: "hypothesis",
				id: "mge_test_002",
				ts: "2026-04-25T02:00:01.000Z",
				signal: { key: "none", signals: [] as string[], error_signature: null },
				gene: { id: null, category: null },
			};

			await appendFile(filePath, JSON.stringify(hypothesisEvent) + "\n", "utf8");

			const entries = await readMemoryGraph(filePath);
			expect(entries).toHaveLength(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("handles mixed formats in same file", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const filePath = path.join(directory, "memory", "mixed.jsonl");
			const { appendFile, mkdir: mkdirFn } = await import("node:fs/promises");
			await mkdirFn(path.dirname(filePath), { recursive: true });

			const bridgeEntry = makeEvolverEntry({
				signals: ["repair_loop_detected"],
				outcome: { status: "failed", score: 0.2, note: "bridge entry" },
			});

			const evolverEvent = {
				type: "MemoryGraphEvent",
				kind: "outcome",
				id: "mge_test_003",
				ts: "2026-04-25T02:00:02.000Z",
				signal: {
					key: "test_failure",
					signals: ["test_failure"],
					error_signature: null,
				},
				outcome: {
					status: "failed",
					score: 0.3,
					note: "evolver entry",
				},
				gene: { id: "gene-mixed", category: "test" },
			};

			await appendFile(
				filePath,
				JSON.stringify(bridgeEntry) + "\n" + JSON.stringify(evolverEvent) + "\n",
				"utf8",
			);

			const entries = await readMemoryGraph(filePath);
			expect(entries).toHaveLength(2);
			expect(entries[0]!.gene_id).toBe(bridgeEntry.gene_id);
			expect(entries[1]!.gene_id).toBe("gene-mixed");
			expect(entries[1]!.source).toBe("evolver:outcome");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

// --- buildMemoryGraphEvent + memoryGraphEventToJsonl tests ---

describe("buildMemoryGraphEvent", () => {
	test("success + fast yields high score", () => {
		const signal = makeSignal({
			result: {
				success: true,
				exitCode: 0,
				durationMs: 100,
				outputDigest: "ok",
				errorSnippet: "",
			},
		});
		const event = buildMemoryGraphEvent(signal, [], { ...require("../src/config.ts").defaultConfig });
		expect(event.status).toBe("success");
		expect(event.score).toBe(0.85);
		expect(event.signals).toContain("stable_success");
		expect(event.geneId).toBeNull();
		expect(event.errorSignature).toBeNull();
	});

	test("success + slow yields moderate score", () => {
		const config = { ...require("../src/config.ts").defaultConfig };
		const signal = makeSignal({
			result: {
				success: true,
				exitCode: 0,
				durationMs: config.slowExecutionMs + 1,
				outputDigest: "slow",
				errorSnippet: "",
			},
		});
		const event = buildMemoryGraphEvent(signal, [], config);
		expect(event.status).toBe("success");
		expect(event.score).toBe(0.65);
		expect(event.signals).toContain("slow_execution");
	});

	test("failure yields low score with log_error", () => {
		const signal = makeSignal({
			result: {
				success: false,
				exitCode: 1,
				durationMs: 50,
				outputDigest: "fail",
				errorSnippet: "crash",
			},
		});
		const event = buildMemoryGraphEvent(signal, [], { ...require("../src/config.ts").defaultConfig });
		expect(event.status).toBe("failure");
		expect(event.score).toBe(0.15);
		expect(event.signals).toContain("log_error");
		expect(event.errorSignature).not.toBeNull();
	});

	test("includes geneId from applied instruction", () => {
		const signal = makeSignal({
			result: {
				success: true,
				exitCode: 0,
				durationMs: 100,
				outputDigest: "ok",
				errorSnippet: "",
			},
		});
		const applied: AppliedEvolverInstruction = {
			instructionId: "inst-1",
			geneId: "gene-42",
			mutationId: "mut-7",
			injectedAt: new Date().toISOString(),
			toolCallIds: ["call-1"],
		};
		const event = buildMemoryGraphEvent(signal, [], { ...require("../src/config.ts").defaultConfig }, applied);
		expect(event.geneId).toBe("gene-42");
		expect(event.mutationId).toBe("mut-7");
		expect(event.note).toContain("gene: gene-42");
	});

	test("without applied instruction, geneId is null", () => {
		const signal = makeSignal({
			result: {
				success: true,
				exitCode: 0,
				durationMs: 50,
				outputDigest: "ok",
				errorSnippet: "",
			},
		});
		const event = buildMemoryGraphEvent(signal, [], { ...require("../src/config.ts").defaultConfig }, null);
		expect(event.geneId).toBeNull();
		expect(event.mutationId).toBeNull();
	});
});

describe("memoryGraphEventToJsonl", () => {
	test("produces valid JSONL line", () => {
		const signal = makeSignal({
			result: {
				success: true,
				exitCode: 0,
				durationMs: 50,
				outputDigest: "ok",
				errorSnippet: "",
			},
		});
		const event = buildMemoryGraphEvent(signal, [], { ...require("../src/config.ts").defaultConfig });
		const line = memoryGraphEventToJsonl(event);
		expect(line).not.toContain("\n");
		const parsed = JSON.parse(line) as Record<string, unknown>;
		expect(parsed.type).toBe("MemoryGraphEvent");
		expect(parsed.kind).toBe("signal");
	});

	test("round-trips through JSONL write", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const filePath = path.join(directory, "memory", "mg_signal.jsonl");
			const signal = makeSignal({
				result: {
					success: false,
					exitCode: 1,
					durationMs: 100,
					outputDigest: "err",
					errorSnippet: "fail",
				},
			});
			const event = buildMemoryGraphEvent(signal, [], { ...require("../src/config.ts").defaultConfig });
			const line = memoryGraphEventToJsonl(event);

			const { appendFile, mkdir: mkdirFn, readFile } = await import("node:fs/promises");
			await mkdirFn(path.dirname(filePath), { recursive: true });
			await appendFile(filePath, line + "\n", "utf8");

			const raw = await readFile(filePath, "utf8");
			const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
			expect(parsed.type).toBe("MemoryGraphEvent");
			expect(parsed.kind).toBe("signal");
			expect(parsed.status).toBe("failure");
			expect(parsed.score).toBe(0.15);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
