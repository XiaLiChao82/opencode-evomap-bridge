import path from "node:path";
import type {
	AppliedEvolverInstruction,
	EvoMapConfig,
	ExecutionAdvisory,
	EvolverGepInstruction,
	Observation,
	ProjectState,
	RawToolSignal,
	SessionState,
} from "./types.ts";
import { toAdvisory } from "./advisory.ts";
import { getDataDir, nowIso, readJsonFile, stableHash, writeJsonFile } from "./util.ts";

function createEmptySessionState(sessionId: string): SessionState {
	return {
		sessionId,
		recentSignals: [],
		observations: [],
		advisories: [],
		updatedAt: nowIso(),
	};
}

function createEmptyProjectState(projectId: string): ProjectState {
	return {
		projectId,
		observations: [],
		advisories: [],
		repoCandidates: [],
		updatedAt: nowIso(),
	};
}

export class EvoMapState {
	private readonly sessionStates = new Map<string, SessionState>();
	private projectState: ProjectState | null = null;

	constructor(
		private readonly directory: string,
		private readonly projectId: string,
		private readonly config: EvoMapConfig,
	) {}

	private get projectStatePath(): string {
		return path.join(getDataDir(this.directory), "project-state.json");
	}

	private get sessionDir(): string {
		return path.join(getDataDir(this.directory), "sessions");
	}

	private getSessionStatePath(sessionId: string): string {
		return path.join(this.sessionDir, `${sessionId}.json`);
	}

	async initialize(): Promise<void> {
		this.projectState = await readJsonFile<ProjectState>(
			this.projectStatePath,
			createEmptyProjectState(this.projectId),
		);
	}

	async getSessionState(sessionId: string): Promise<SessionState> {
		const existing = this.sessionStates.get(sessionId);
		if (existing) {
			return existing;
		}
		const loaded = await readJsonFile<SessionState>(
			this.getSessionStatePath(sessionId),
			createEmptySessionState(sessionId),
		);
		this.sessionStates.set(sessionId, loaded);
		return loaded;
	}

	getProjectState(): ProjectState {
		if (!this.projectState) {
			this.projectState = createEmptyProjectState(this.projectId);
		}
		return this.projectState;
	}

	async appendSignal(signal: RawToolSignal): Promise<SessionState> {
		const state = await this.getSessionState(signal.sessionId);
		state.recentSignals = [...state.recentSignals, signal].slice(
			-this.config.maxRecentSignals,
		);
		state.updatedAt = nowIso();
		await this.persistSessionState(state);
		return state;
	}

	async appendObservations(
		sessionId: string,
		observations: Observation[],
	): Promise<void> {
		if (observations.length === 0) {
			return;
		}
		const sessionState = await this.getSessionState(sessionId);
		const projectState = this.getProjectState();

		for (const observation of observations) {
			if (
				!sessionState.observations.some(
					(item) => item.fingerprint === observation.fingerprint,
				)
			) {
				sessionState.observations.push(observation);
				sessionState.advisories.push(toAdvisory(observation, this.config, "session"));
			}

			if (observation.projectEligible) {
				if (
					!projectState.observations.some(
						(item) => item.fingerprint === observation.fingerprint,
					)
				) {
					projectState.observations.push(observation);
					projectState.advisories.push(toAdvisory(observation, this.config, "project"));
					projectState.repoCandidates.push(observation);
				}
			}
		}

		sessionState.updatedAt = nowIso();
		projectState.updatedAt = nowIso();

		await Promise.all([
			this.persistSessionState(sessionState),
			this.persistProjectState(),
		]);
	}

	async updateSessionAdvisories(
		sessionId: string,
		advisories: ExecutionAdvisory[],
	): Promise<void> {
		const state = await this.getSessionState(sessionId);
		const byId = new Map(advisories.map((advisory) => [advisory.id, advisory]));
		state.advisories = state.advisories.map(
			(advisory) => byId.get(advisory.id) ?? advisory,
		);
		state.updatedAt = nowIso();
		await this.persistSessionState(state);
	}

	async updateProjectAdvisories(advisories: ExecutionAdvisory[]): Promise<void> {
		const state = this.getProjectState();
		const byId = new Map(advisories.map((advisory) => [advisory.id, advisory]));
		state.advisories = state.advisories.map(
			(advisory) => byId.get(advisory.id) ?? advisory,
		);
		state.updatedAt = nowIso();
		await this.persistProjectState();
	}

	async setActiveInstruction(
		sessionId: string,
		instruction: EvolverGepInstruction | null,
	): Promise<void> {
		const state = await this.getSessionState(sessionId);
		state.activeInstruction = instruction;
		state.updatedAt = nowIso();
		await this.persistSessionState(state);
	}

	async getActiveInstruction(
		sessionId: string,
	): Promise<EvolverGepInstruction | null> {
		const state = await this.getSessionState(sessionId);
		const instruction = state.activeInstruction ?? null;
		if (!instruction) {
			return null;
		}
		const now = Date.now();
		const expires = Date.parse(instruction.expiresAt);
		if (now >= expires) {
			state.activeInstruction = null;
			state.updatedAt = nowIso();
			await this.persistSessionState(state);
			return null;
		}
		return instruction;
	}

	async clearActiveInstruction(sessionId: string): Promise<void> {
		const state = await this.getSessionState(sessionId);
		state.activeInstruction = null;
		state.updatedAt = nowIso();
		await this.persistSessionState(state);
	}

	async recordInstructionApplied(
		sessionId: string,
		instructionId: string,
		toolCallId: string,
	): Promise<void> {
		const state = await this.getSessionState(sessionId);
		if (!state.appliedInstructions) {
			state.appliedInstructions = [];
		}

		const existing = state.appliedInstructions.find(
			(entry) => entry.instructionId === instructionId,
		);

		if (existing) {
			existing.toolCallIds.push(toolCallId);
		} else {
			const instruction = state.activeInstruction;
			state.appliedInstructions.push({
				instructionId,
				geneId: instruction?.geneId ?? null,
				mutationId: instruction?.mutationId ?? null,
				injectedAt: nowIso(),
				toolCallIds: [toolCallId],
			});
		}

		if (
			existing &&
			existing.toolCallIds.length >= this.config.maxAdvisoryUses
		) {
			state.activeInstruction = null;
		}

		state.updatedAt = nowIso();
		await this.persistSessionState(state);
	}

	async getAppliedInstructionForCall(
		sessionId: string,
		toolCallId: string,
	): Promise<AppliedEvolverInstruction | null> {
		const state = await this.getSessionState(sessionId);
		const applied = state.appliedInstructions ?? [];
		for (const entry of applied) {
			if (entry.toolCallIds.includes(toolCallId)) {
				return entry;
			}
		}
		return null;
	}

	private async persistSessionState(state: SessionState): Promise<void> {
		await writeJsonFile(this.getSessionStatePath(state.sessionId), state);
	}

	private async persistProjectState(): Promise<void> {
		await writeJsonFile(this.projectStatePath, this.getProjectState());
	}
}

export function buildSignalId(
	sessionId: string,
	callId: string,
	tool: string,
): string {
	return stableHash(`${sessionId}:${callId}:${tool}:${nowIso()}`);
}
