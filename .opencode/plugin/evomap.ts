import { type Plugin } from "@opencode-ai/plugin";
import {
	hasSyntheticSentinel,
	markAdvisoryUsed,
	pickAdvisories,
	renderAdvisories,
} from "../../src/advisory.ts";
import { resolveConfig } from "../../src/config.ts";
import { deriveObservationsWithEvolver } from "../../src/evolver.ts";
import { SignalQueue } from "../../src/queue.ts";
import { buildSignalId, EvoMapState } from "../../src/state.ts";
import type {
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
		const sessionState = await state.getSessionState(signal.sessionId);
		const observations = await deriveObservationsWithEvolver(
			signal,
			sessionState.recentSignals,
			config,
			dir,
		);
		await state.appendObservations(signal.sessionId, observations);
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
			});
		},
	};
};
