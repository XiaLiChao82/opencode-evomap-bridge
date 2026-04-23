import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
	EvolverMemoryEntry,
	Observation,
	ObservationType,
	RawToolSignal,
	ToolName,
} from "./types.ts";
import { clampText, nowIso, stableHash } from "./util.ts";

const observationTypeToEvolverSignal: Record<ObservationType, string> = {
	repeat_failure: "repair_loop_detected",
	repeat_success: "stable_success_plateau",
	slow_execution: "perf_bottleneck",
};

const evolverSignalToObservationType: Record<string, ObservationType> = {
	repair_loop_detected: "repeat_failure",
	stable_success_plateau: "repeat_success",
	perf_bottleneck: "slow_execution",
	log_error: "repeat_failure",
	test_failure: "repeat_failure",
	capability_gap: "slow_execution",
};

export function signalToEvolverEntry(signal: RawToolSignal): EvolverMemoryEntry {
	const evolverSignals: string[] = [];

	if (!signal.result.success) {
		evolverSignals.push("log_error");
	}
	if ((signal.result.durationMs ?? 0) > 0 && signal.result.success) {
		evolverSignals.push("stable_success_plateau");
	}

	const status = signal.result.success ? "success" : "failed";
	const score = signal.result.success
		? 0.7 + Math.random() * 0.2
		: 0.1 + Math.random() * 0.2;

	return {
		timestamp: signal.createdAt,
		gene_id: "ad_hoc",
		signals: evolverSignals.length > 0 ? evolverSignals : ["log_error"],
		outcome: {
			status,
			score: Math.round(score * 100) / 100,
			note: clampText(
				`${signal.tool} call: ${status}${signal.result.errorSnippet ? ` - ${signal.result.errorSnippet}` : ""}`,
				200,
			),
		},
		source: "opencode-bridge:tool.after",
	};
}

export function evolverEntryToObservation(entry: EvolverMemoryEntry): Observation | null {
	const matchingType = entry.signals
		.map((s) => evolverSignalToObservationType[s])
		.find((t) => t !== undefined);
	if (!matchingType) {
		return null;
	}

	const createdAt = entry.timestamp;
	return {
		id: stableHash(`evolver:${entry.gene_id}:${entry.timestamp}:${matchingType}`),
		type: matchingType,
		tool: "unknown" as ToolName,
		sessionId: "",
		projectId: "",
		fingerprint: stableHash(`evolver:${matchingType}:${entry.gene_id}`),
		message: entry.outcome.note,
		confidence: entry.outcome.score,
		occurrenceCount: 1,
		evidenceSignalIds: [],
		pathHints: [],
		createdAt,
		lastSeenAt: createdAt,
		projectEligible: false,
	};
}

export async function readMemoryGraph(filePath: string): Promise<EvolverMemoryEntry[]> {
	try {
		const raw = await readFile(filePath, "utf8");
		const entries: EvolverMemoryEntry[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			try {
				entries.push(JSON.parse(trimmed) as EvolverMemoryEntry);
			} catch {
				continue;
			}
		}
		return entries;
	} catch {
		return [];
	}
}

export async function appendMemoryGraph(
	filePath: string,
	entry: EvolverMemoryEntry,
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const line = JSON.stringify(entry) + "\n";
	await appendFile(filePath, line, "utf8");
}

export function evolverGEPObservations(memoryEntries: EvolverMemoryEntry[]): Observation[] {
	const observations: Observation[] = [];
	const seen = new Set<string>();

	for (const entry of memoryEntries) {
		const observation = evolverEntryToObservation(entry);
		if (observation && !seen.has(observation.fingerprint)) {
			seen.add(observation.fingerprint);
			observations.push(observation);
		}
	}

	return observations;
}
