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
	result: {
		success: boolean;
		exitCode: number | null;
		durationMs: number | null;
		outputDigest: string;
		errorSnippet: string;
	};
}

export type ObservationType =
	| "repeat_failure"
	| "repeat_success"
	| "slow_execution";

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
}

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
