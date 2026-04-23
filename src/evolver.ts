import {
	appendMemoryGraph,
	evolverGEPObservations,
	readMemoryGraph,
	signalToEvolverEntry,
} from "./bridge.ts";
import {
	getEvolverRoot,
	getMemoryGraphPath,
	isEvolverAvailable,
	spawnEvolver,
} from "./spawn.ts";
import type { EvoMapConfig, Observation, RawToolSignal, ToolName } from "./types.ts";
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
): Promise<Observation[]> {
	try {
		const available = await isEvolverAvailable();
		if (!available) {
			if (config.debug) {
				console.warn("[EvoMapBridge/evolver] evolver not available, using local rules");
			}
			return config.evolverFallbackToLocal
				? deriveObservations(signal, recentSignals, config)
				: [];
		}

		const entry = signalToEvolverEntry(signal);
		const evolverRoot = getEvolverRoot(directory);
		const memoryPath = getMemoryGraphPath(evolverRoot);

		await appendMemoryGraph(memoryPath, entry);

		const result = await spawnEvolver({
			command: "run",
			cwd: directory,
			timeoutMs: config.evolverSpawnTimeoutMs,
		});

		if (result.exitCode !== 0 || result.timedOut) {
			if (config.debug) {
				console.warn("[EvoMapBridge/evolver] spawn failed or timed out", {
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					stderr: result.stderr,
				});
			}
			return config.evolverFallbackToLocal
				? deriveObservations(signal, recentSignals, config)
				: [];
		}

		const entries = await readMemoryGraph(memoryPath);
		const observations = evolverGEPObservations(entries);

		if (observations.length === 0 && config.evolverFallbackToLocal) {
			if (config.debug) {
				console.warn("[EvoMapBridge/evolver] no observations from evolver, using local rules");
			}
			return deriveObservations(signal, recentSignals, config);
		}

		if (config.debug) {
			console.warn("[EvoMapBridge/evolver] derived observations from evolver", {
				count: observations.length,
			});
		}

		return observations;
	} catch (error) {
		if (config.debug) {
			console.warn("[EvoMapBridge/evolver] error in evolver integration", error);
		}
		return config.evolverFallbackToLocal
			? deriveObservations(signal, recentSignals, config)
			: [];
	}
}
