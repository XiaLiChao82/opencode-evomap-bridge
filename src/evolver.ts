import {
	appendMemoryGraph,
	memoryEntriesToObservations,
	readMemoryGraph,
	signalToEvolverEntry,
} from "./bridge.ts";
import {
	getEvolverRoot,
	getMemoryGraphPath,
	isEvolverAvailable,
	spawnEvolver,
} from "./spawn.ts";
import type { EvoMapConfig, EvolverFallbackReason, EvolverRunStatus, Observation, RawToolSignal, ToolName } from "./types.ts";
import { nowIso, stableHash } from "./util.ts";

function countMatchingSignals(
	signals: RawToolSignal[],
	predicate: (signal: RawToolSignal) => boolean,
): RawToolSignal[] {
	return signals.filter(predicate);
}

function makeObservation(
	signal: RawToolSignal,
	config: EvoMapConfig,
	tool: ToolName,
	type: Observation["type"],
	message: string,
	occurrenceCount: number,
	evidenceSignalIds: string[],
	confidence: number,
	source: Observation["source"] = "local-rules",
): Observation {
	const createdAt = nowIso();
	return {
		id: stableHash(`${type}:${tool}:${signal.sessionId}:${signal.result.outputDigest}:${createdAt}`),
		type,
		tool,
		sessionId: signal.sessionId,
		projectId: signal.projectId,
		fingerprint: stableHash(`${type}:${tool}:${signal.result.outputDigest}`),
		message,
		confidence,
		occurrenceCount,
		evidenceSignalIds,
		pathHints: signal.pathHints,
		createdAt,
		lastSeenAt: createdAt,
		projectEligible: occurrenceCount >= config.projectPromotionThreshold,
		source,
	};
}

export function deriveObservations(
	signal: RawToolSignal,
	recentSignals: RawToolSignal[],
	config: EvoMapConfig,
): Observation[] {
	const observations: Observation[] = [];
	const sameToolSignals = recentSignals.filter((item) => item.tool === signal.tool);

	if (!signal.result.success) {
		const matchingFailures = countMatchingSignals(
			sameToolSignals,
			(item) => !item.result.success && item.result.outputDigest === signal.result.outputDigest,
		);
		const occurrenceCount = matchingFailures.length;
		if (occurrenceCount >= config.repeatFailureThreshold) {
			observations.push(
				makeObservation(
					signal,
					config,
					signal.tool,
					"repeat_failure",
					`Repeated ${signal.tool} failures detected. Avoid retrying the same failing pattern without narrowing the scope or checking diagnostics first.`,
					occurrenceCount,
					matchingFailures.map((item) => item.id),
					0.9,
				),
			);
		}
	}

	if (signal.result.success) {
		const matchingSuccesses = countMatchingSignals(
			sameToolSignals,
			(item) => item.result.success && item.result.outputDigest === signal.result.outputDigest,
		);
		const occurrenceCount = matchingSuccesses.length;
		if (occurrenceCount >= config.repeatSuccessThreshold) {
			observations.push(
				makeObservation(
					signal,
					config,
					signal.tool,
					"repeat_success",
					`Recent ${signal.tool} calls with a similar shape succeeded. Reuse this narrow pattern before expanding scope.`,
					occurrenceCount,
					matchingSuccesses.map((item) => item.id),
					0.7,
				),
			);
		}
	}

	if ((signal.result.durationMs ?? 0) >= config.slowExecutionMs) {
		observations.push(
			makeObservation(
				signal,
				config,
				signal.tool,
				"slow_execution",
				`${signal.tool} recently ran slowly. Prefer tighter file globs, offsets, or smaller command scopes before repeating it.`,
				1,
				[signal.id],
				0.6,
			),
		);
	}

	return observations;
}

export async function deriveObservationsWithEvolver(
	signal: RawToolSignal,
	recentSignals: RawToolSignal[],
	config: EvoMapConfig,
	directory: string,
): Promise<EvolverRunStatus> {
	const fallback = (reason: EvolverFallbackReason): EvolverRunStatus => {
		if (!config.evolverFallbackToLocal) {
			return { ok: false, reason, observations: [] };
		}
		return { ok: false, reason, observations: deriveObservations(signal, recentSignals, config) };
	};

	try {
		const available = await isEvolverAvailable();
		if (!available) {
			if (config.debug) {
				console.warn("[EvoMapBridge/evolver] evolver not available, using local rules");
			}
			return fallback("evolver-not-available");
		}

		const entry = signalToEvolverEntry(signal);
		const evolverRoot = getEvolverRoot(directory);
		const memoryPath = getMemoryGraphPath(evolverRoot);

		await appendMemoryGraph(memoryPath, entry);

		const result = await spawnEvolver({
			command: "run",
			cwd: directory,
			timeoutMs: config.evolverRunTimeoutMs,
			retries: config.evolverRunRetries,
			retryDelayMs: config.evolverRetryDelayMs,
			label: "derive-observations",
		});

		if (result.timedOut) {
			if (config.debug) {
				console.warn("[EvoMapBridge/evolver] spawn timed out", {
					durationMs: result.durationMs,
					attempt: result.attempt,
				});
			}
			return fallback("spawn-timed-out");
		}

		if (result.exitCode !== 0) {
			if (config.debug) {
				console.warn("[EvoMapBridge/evolver] spawn failed", {
					exitCode: result.exitCode,
					stderr: result.stderr,
					attempt: result.attempt,
				});
			}
			return fallback("spawn-failed");
		}

		const entries = await readMemoryGraph(memoryPath);
		const observations = memoryEntriesToObservations(entries);

		if (observations.length === 0) {
			if (config.debug) {
				console.warn("[EvoMapBridge/evolver] no observations from evolver, using local rules");
			}
			return fallback("no-observations");
		}

		if (config.debug) {
			console.warn("[EvoMapBridge/evolver] derived observations from evolver", {
				count: observations.length,
			});
		}

		return { ok: true, source: "evolver-log", observations };
	} catch (error) {
		if (config.debug) {
			console.warn("[EvoMapBridge/evolver] error in evolver integration", error);
		}
		return fallback("unexpected-error");
	}
}
