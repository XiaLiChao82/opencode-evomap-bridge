import { type Plugin } from "@opencode-ai/plugin";
import {
	formatMemorySummary,
	readMemoryGraph,
	appendMemoryGraph,
	buildMemoryGraphEvent,
	memoryGraphEventToJsonl,
} from "../../src/bridge.ts";
import {
	hasSyntheticSentinel,
	markAdvisoryUsed,
	pickAdvisories,
	renderAdvisories,
} from "../../src/advisory.ts";
import { resolveConfig } from "../../src/config.ts";
import { deriveAnalysisWithEvolver } from "../../src/evolver.ts";
import { renderGepInstruction } from "../../src/gep.ts";
import { SignalQueue } from "../../src/queue.ts";
import {
	isEvolverAvailable,
	getEvolverRoot,
	getMemoryGraphPath,
	spawnEvolver,
} from "../../src/spawn.ts";
import { buildSignalId, EvoMapState } from "../../src/state.ts";
import type {
	EvolverMemoryEntry,
	EvoMapConfig,
	RawToolSignal,
	ToolAfterInput,
	ToolAfterOutput,
	ToolBeforeInput,
	ToolBeforeOutput,
	ToolName,
} from "../../src/types.ts";
import {
	clampText,
	getProjectKey,
	nowIso,
	pathHintsFromArgs,
	stableHash,
} from "../../src/util.ts";

const knownTools = new Set<ToolName>([
	"bash",
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"lsp_diagnostics",
	"unknown",
]);

function normalizeToolName(tool: string): ToolName {
	if (knownTools.has(tool as ToolName)) {
		return tool as ToolName;
	}
	return "unknown";
}

function isSuccessful(output: ToolAfterOutput): boolean {
	if (typeof output.metadata?.success === "boolean") {
		return output.metadata.success;
	}
	if (typeof output.metadata?.exitCode === "number") {
		return output.metadata.exitCode === 0;
	}
	return true;
}

function getDurationMs(output: ToolAfterOutput): number | null {
	const candidates = [
		output.metadata?.durationMs,
		output.metadata?.duration,
		output.metadata?.elapsedMs,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
	}
	return null;
}

function getExitCode(output: ToolAfterOutput): number | null {
	if (typeof output.metadata?.exitCode === "number") {
		return output.metadata.exitCode;
	}
	return null;
}

function buildSignal(
	input: ToolAfterInput,
	args: Record<string, unknown>,
	output: ToolAfterOutput,
	directory: string,
	config: EvoMapConfig,
): RawToolSignal {
	const originalOutput = output.output;
	return {
		id: buildSignalId(input.sessionID, input.callID, input.tool),
		sessionId: input.sessionID,
		projectId: getProjectKey(directory),
		tool: normalizeToolName(input.tool),
		callId: input.callID,
		createdAt: nowIso(),
		args: { ...args },
		pathHints: pathHintsFromArgs(args),
		result: {
			success: isSuccessful(output),
			exitCode: getExitCode(output),
			durationMs: getDurationMs(output),
			outputDigest: stableHash(originalOutput),
			errorSnippet: isSuccessful(output)
				? ""
				: clampText(originalOutput, config.maxSignalSummaryChars),
		},
	};
}

export const EvoMapBridgePlugin: Plugin = async ({ directory }) => {
	const config = resolveConfig();
	if (!config.enabled) {
		return {};
	}

	const state = new EvoMapState(directory, getProjectKey(directory), config);
	await state.initialize();

	const pendingAdvisories = new Map<string, ReturnType<typeof pickAdvisories>>();
	const pendingArgs = new Map<string, Record<string, unknown>>();
	let internalErrors = 0;
	let disabled = false;
	const evolverBinary = config.evolverBinary;

	// Cache pre-warmed by session.created, consumed by system.transform
	let cachedMemoryEntries: EvolverMemoryEntry[] | null = null;

	const failOpen = async (fn: () => Promise<void>): Promise<void> => {
		if (disabled) {
			return;
		}
		try {
			await fn();
			internalErrors = 0;
		} catch (error) {
			internalErrors += 1;
			console.warn("[EvoMapBridge] fail-open", error);
			if (internalErrors >= config.internalErrorThreshold) {
				disabled = true;
				console.warn("[EvoMapBridge] disabled after repeated internal errors");
			}
		}
	};

	const queue = new SignalQueue(config, directory, async (signal, dir) => {
		await state.appendSignal(signal);
		const analysis = await deriveAnalysisWithEvolver(
			signal,
			config,
			dir,
			signal.sessionId,
			signal.projectId,
		);
		await state.appendObservations(signal.sessionId, analysis.observations);
		if (analysis.instruction) {
			await state.setActiveInstruction(signal.sessionId, analysis.instruction);
		}
	});

	return {
		"tool.execute.before": async (
			input: ToolBeforeInput,
			output: ToolBeforeOutput,
		) => {
			await failOpen(async () => {
				pendingArgs.set(input.callID, { ...output.args });
				const tool = normalizeToolName(input.tool);
				const sessionState = await state.getSessionState(input.sessionID);
				const projectState = state.getProjectState();
				const isoNow = nowIso();

				const activeInstruction = await state.getActiveInstruction(input.sessionID);
				if (activeInstruction) {
					await state.recordInstructionApplied(
						input.sessionID,
						activeInstruction.id,
						input.callID,
					);
				}

				const sessionAdvisories = pickAdvisories(
					tool,
					sessionState.advisories,
					config,
					isoNow,
				);
				const projectAdvisories = pickAdvisories(
					tool,
					projectState.advisories,
					config,
					isoNow,
				);
				const chosen = [...sessionAdvisories, ...projectAdvisories].slice(
					0,
					config.maxAdvisoriesPerCall,
				);

				if (chosen.length === 0) {
					pendingAdvisories.delete(input.callID);
					return;
				}

				pendingAdvisories.set(input.callID, chosen);

				const usedSession = sessionState.advisories.map((advisory) => {
					const match = chosen.find(
						(item) => item.id === advisory.id && item.source === "session",
					);
					return match ? markAdvisoryUsed(advisory, config, isoNow) : advisory;
				});
				const usedProject = projectState.advisories.map((advisory) => {
					const match = chosen.find(
						(item) => item.id === advisory.id && item.source === "project",
					);
					return match ? markAdvisoryUsed(advisory, config, isoNow) : advisory;
				});

				await Promise.all([
					state.updateSessionAdvisories(input.sessionID, usedSession),
					state.updateProjectAdvisories(usedProject),
				]);
			});
		},

		"tool.execute.after": async (
			input: ToolAfterInput,
			output: ToolAfterOutput,
		) => {
			await failOpen(async () => {
				const originalOutput = output.output;
				const pending = pendingAdvisories.get(input.callID) ?? [];
				const args = pendingArgs.get(input.callID) ?? {};
				pendingAdvisories.delete(input.callID);
				pendingArgs.delete(input.callID);

				if (!hasSyntheticSentinel(originalOutput)) {
					const rendered = renderAdvisories(pending);
					if (rendered) {
						output.output = `${originalOutput}\n\n${rendered}`;
					}
				}

				const signal = buildSignal(
					input,
					args,
					{ ...output, output: originalOutput },
					directory,
					config,
				);
				queue.push(signal);

				const appliedInstruction = await state.getAppliedInstructionForCall(
					input.sessionID,
					input.callID,
				);
				const sessionState = await state.getSessionState(input.sessionID);
				const mgEvent = buildMemoryGraphEvent(
					signal,
					sessionState.recentSignals,
					config,
					appliedInstruction,
				);
				const evolverRoot = getEvolverRoot(directory);
				const memoryPath = getMemoryGraphPath(evolverRoot);
				const { appendFile: appendFileFn, mkdir: mkdirFn } = await import("node:fs/promises");
				const pathModule = await import("node:path");
				await mkdirFn(pathModule.dirname(memoryPath), { recursive: true });
				await appendFileFn(memoryPath, memoryGraphEventToJsonl(mgEvent) + "\n", "utf8");
			});
		},

		event: async (input: { event: { type: string; sessionID?: string; [key: string]: unknown } }) => {
			if (input.event.type === "session.created") {
				await failOpen(async () => {
					const available = await isEvolverAvailable(evolverBinary);
					if (!available) {
						return;
					}

					const evolverRoot = getEvolverRoot(directory);
					const memoryPath = getMemoryGraphPath(evolverRoot);
					const allEntries = await readMemoryGraph(memoryPath);
					const recentEntries = allEntries.slice(-10);

					if (recentEntries.length === 0) {
						if (config.debug) {
							console.warn("[EvoMapBridge/session-start] no memory entries found");
						}
						return;
					}

					cachedMemoryEntries = recentEntries;

					console.warn(
						`[EvoMapBridge/session-start] cached ${recentEntries.length} memory entries for session ${input.event.sessionID ?? "unknown"}`,
					);
					if (config.debug) {
						const summary = formatMemorySummary(recentEntries);
						if (summary) {
							console.warn("[EvoMapBridge/session-start]", summary);
						}
					}
				});
			}

			if (input.event.type === "session.idle") {
				await failOpen(async () => {
					const available = await isEvolverAvailable(evolverBinary);
					if (!available) {
						return;
					}

					const sessionId = input.event.sessionID ?? "unknown";
					const evolverRoot = getEvolverRoot(directory);
					const memoryPath = getMemoryGraphPath(evolverRoot);

					const sessionEndEntry: EvolverMemoryEntry = {
						timestamp: nowIso(),
						gene_id: "session_end",
						signals: ["session_idle"],
						outcome: {
							status: "neutral",
							score: 0.5,
							note: `session ${sessionId} ended`,
						},
						source: "opencode-bridge:session.idle",
					};

					await appendMemoryGraph(memoryPath, sessionEndEntry);

					if (config.debug) {
						console.warn(
							`[EvoMapBridge/session-end] appended session-end entry for ${sessionId}`,
						);
					}

					try {
						const result = await spawnEvolver(
							{
								command: "run",
								cwd: directory,
								timeoutMs: config.evolverSpawnTimeoutMs,
							},
							evolverBinary,
						);
						if (result.timedOut) {
							console.warn("[EvoMapBridge/session-end] evolver run timed out");
						} else if (result.exitCode !== 0) {
							console.warn(
								`[EvoMapBridge/session-end] evolver run exited with code ${result.exitCode}`,
							);
						}
					} catch (error) {
						console.warn("[EvoMapBridge/session-end] evolver spawn failed", error);
					}
				});
			}
		},

		"experimental.chat.system.transform": async (
			_input: { sessionID?: string; model: unknown },
			output: { system: string[] },
		) => {
			await failOpen(async () => {
				// 1. Inject active GEP instruction if present
				if (_input.sessionID) {
					const activeInstruction = await state.getActiveInstruction(_input.sessionID);
					if (activeInstruction) {
						output.system.push(renderGepInstruction(activeInstruction));
					}
				}

				// 2. Inject evolver memory summary from session start cache
				const recentEntries = cachedMemoryEntries;
				cachedMemoryEntries = null;

				if (recentEntries && recentEntries.length > 0) {
					const memorySummary = formatMemorySummary(recentEntries);
					if (memorySummary) {
						output.system.push(memorySummary);
					}
					return;
				}

				// 3. Fallback: read memory graph directly (no local observations)
				const evolverRoot = getEvolverRoot(directory);
				const memoryPath = getMemoryGraphPath(evolverRoot);
				const allEntries = await readMemoryGraph(memoryPath);
				const lastEntries = allEntries.slice(-10);

				if (lastEntries.length === 0) {
					return;
				}

				const memorySummary = formatMemorySummary(lastEntries);
				if (memorySummary) {
					output.system.push(memorySummary);
				}
			});
		},

		"experimental.session.compacting": async (
			input: { sessionID: string },
			output: { context: string[]; prompt?: string },
		) => {
			await failOpen(async () => {
				const sessionState = await state.getSessionState(input.sessionID);
				const projectState = state.getProjectState();

				const parts: string[] = [];

				if (sessionState.observations.length > 0) {
					const obsSummary = sessionState.observations
						.slice(-10)
						.map((obs) => `[${obs.type}] ${obs.message}`)
						.join("\n");
					parts.push(`[EvoMap Bridge] Session observations:\n${obsSummary}`);
				}

				if (projectState.observations.length > 0) {
					const projSummary = projectState.observations
						.slice(-5)
						.map((obs) => `[${obs.type}] ${obs.message}`)
						.join("\n");
					parts.push(`[EvoMap Bridge] Project observations:\n${projSummary}`);
				}

				const available = await isEvolverAvailable(evolverBinary);
				if (available) {
					const evolverRoot = getEvolverRoot(directory);
					const memoryPath = getMemoryGraphPath(evolverRoot);
					const allEntries = await readMemoryGraph(memoryPath);
					const recentEntries = allEntries.slice(-10);
					const memorySummary = formatMemorySummary(recentEntries);
					if (memorySummary) {
						parts.push(memorySummary);
					}
				}

				for (const part of parts) {
					output.context.push(part);
				}
			});
		},
	};
};
