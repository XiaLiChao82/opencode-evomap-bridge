export interface EvoMapConfig {
	enabled: boolean;
	maxRecentSignals: number;
	maxSignalSummaryChars: number;
	maxAdvisoriesPerCall: number;
	maxAdvisoryUses: number;
	advisoryCooldownMs: number;
	repeatFailureThreshold: number;
	repeatSuccessThreshold: number;
	slowExecutionMs: number;
	projectPromotionThreshold: number;
	internalErrorThreshold: number;
	debug: boolean;
	evolverBinary: string;
	evolverRunTimeoutMs: number;
	evolverRunRetries: number;
	evolverRetryDelayMs: number;
	evolverFallbackToLocal: boolean;
}

export type ToolName =
	| "bash"
	| "read"
	| "write"
	| "edit"
	| "glob"
	| "grep"
	| "lsp_diagnostics"
	| "unknown";

export interface RawToolSignal {
	id: string;
	sessionId: string;
	projectId: string;
	tool: ToolName;
	callId: string;
	createdAt: string;
	args: Record<string, unknown>;
	pathHints: string[];
	toolCategory: ToolCategory;
	argsSummary: string;
	sessionPhase: SessionPhase;
	failureKind: FailureKind;
	result: {
		success: boolean;
		exitCode: number | null;
		durationMs: number | null;
		outputDigest: string;
		errorSnippet: string;
	};
}

export type ToolCategory = "file-read" | "file-write" | "search" | "diagnostics" | "execution" | "unknown";

export type SessionPhase = "early" | "mid" | "late";

export type FailureKind = "none" | "timeout" | "error" | "empty-result" | "permission-denied" | "unknown";

export type ObservationType =
	| "repeat_failure"
	| "repeat_success"
	| "slow_execution";

export type ObservationSource =
	| "local-rules"
	| "evolver-log"
	| "evolver-analysis";

export interface Observation {
	id: string;
	type: ObservationType;
	tool: ToolName;
	sessionId: string;
	projectId: string;
	fingerprint: string;
	message: string;
	confidence: number;
	occurrenceCount: number;
	evidenceSignalIds: string[];
	pathHints: string[];
	createdAt: string;
	lastSeenAt: string;
	projectEligible: boolean;
	source: ObservationSource;
}

export type EvolverRunStatus =
	| { ok: true; source: ObservationSource; observations: Observation[] }
	| { ok: false; reason: EvolverFallbackReason; observations: Observation[] };

export type EvolverFallbackReason =
	| "evolver-not-available"
	| "spawn-failed"
	| "spawn-timed-out"
	| "no-observations"
	| "unexpected-error";

export interface ExecutionAdvisory {
	id: string;
	tool: ToolName;
	message: string;
	observationId: string;
	createdAt: string;
	lastUsedAt: string | null;
	useCount: number;
	maxUses: number;
	cooldownUntil: string | null;
	pathHints: string[];
	source: "session" | "project";
}

export interface SessionState {
	sessionId: string;
	recentSignals: RawToolSignal[];
	observations: Observation[];
	advisories: ExecutionAdvisory[];
	updatedAt: string;
}

export interface ProjectState {
	projectId: string;
	observations: Observation[];
	advisories: ExecutionAdvisory[];
	repoCandidates: Observation[];
	updatedAt: string;
}

export interface ToolBeforeInput {
	tool: string;
	sessionID: string;
	callID: string;
}

export interface ToolBeforeOutput {
	args: Record<string, unknown>;
}

export interface ToolAfterInput extends ToolBeforeInput {}

export interface ToolAfterOutput {
	title: string;
	output: string;
	metadata?: Record<string, unknown>;
}

// --- Evolver integration types ---

export interface EvolverMemoryEntry {
	timestamp: string;
	gene_id: string;
	signals: string[];
	outcome: {
		status: "success" | "failed" | "neutral";
		score: number;
		note: string;
	};
	source: string;
}

export interface EvolverSpawnOptions {
	command: string;
	args?: string[];
	stdin?: string;
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
	retries?: number;
	retryDelayMs?: number;
	label?: string;
}

export interface EvolverSpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	attempt: number;
}

export interface EvolverDetection {
	path: string;
	version: string;
}
