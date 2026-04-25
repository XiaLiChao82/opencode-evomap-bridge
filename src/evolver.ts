import {
	appendMemoryGraph,
	evolverGEPObservations,
	readMemoryGraph,
	signalToEvolverEntry,
} from "./bridge.ts";
import { parseEvolverRunOutput } from "./gep.ts";
import {
	getEvolverRoot,
	getMemoryGraphPath,
	isEvolverAvailable,
	spawnEvolver,
} from "./spawn.ts";
import type { EvoMapConfig, EvolverAnalysisResult, RawToolSignal } from "./types.ts";

export async function deriveAnalysisWithEvolver(
	signal: RawToolSignal,
	config: EvoMapConfig,
	directory: string,
	sessionId: string,
	projectId: string,
): Promise<EvolverAnalysisResult> {
	try {
		const available = await isEvolverAvailable(config.evolverBinary);
		if (!available) {
			return { observations: [], instruction: null };
		}

		const entry = signalToEvolverEntry(signal);
		const evolverRoot = getEvolverRoot(directory);
		const memoryPath = getMemoryGraphPath(evolverRoot);
		await appendMemoryGraph(memoryPath, entry);

		const result = await spawnEvolver(
			{ command: "run", cwd: directory, timeoutMs: config.evolverSpawnTimeoutMs },
			config.evolverBinary,
		);

		if (result.exitCode !== 0 || result.timedOut) {
			if (config.debug) {
				console.warn("[EvoMapBridge/analysis] evolver run failed", {
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					stderr: result.stderr,
				});
			}
			return { observations: [], instruction: null };
		}

		const instruction = parseEvolverRunOutput(result.stdout, { sessionId, projectId });

		const entries = await readMemoryGraph(memoryPath);
		const observations = evolverGEPObservations(entries);

		return { observations, instruction };
	} catch (error) {
		if (config.debug) {
			console.warn("[EvoMapBridge/analysis] error in evolver integration", error);
		}
		return { observations: [], instruction: null };
	}
}
