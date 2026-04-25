export interface EvolverGepInstruction {
	id: string;
	createdAt: string;
	sessionId: string;
	projectId: string;
	prompt: string;
	geneId: string | null;
	geneCategory?: string | null;
	mutationId?: string | null;
	mutationCategory?: string | null;
	riskLevel?: string | null;
	capsuleIds?: string[];
	source: "evolver.stdout" | "memory_graph";
	/** Default TTL: 30 min from createdAt */
	expiresAt: string;
}

export interface AppliedEvolverInstruction {
	instructionId: string;
	geneId: string | null;
	mutationId?: string | null;
	injectedAt: string;
	toolCallIds: string[];
}

export interface EvolverAnalysisResult {
	observations: Observation[];
	instruction: EvolverGepInstruction | null;
}

export interface MemoryGraphSignalEvent {
	type: "MemoryGraphEvent";
	kind: "signal";
	id: string;
	ts: string;
	toolName: string;
	status: "success" | "failure";
	durationMs: number;
	signals: string[];
	errorSignature: string | null;
	score: number;
	note: string;
	geneId: string | null;
	mutationId: string | null;
	mutationCategory: string | null;
	riskLevel: string | null;
}

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
	evolverSpawnTimeoutMs: number;
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
	activeInstruction?: EvolverGepInstruction | null;
	appliedInstructions?: AppliedEvolverInstruction[];
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

export interface MemoryGraphEvent {
	type: "MemoryGraphEvent";
	kind: "signal" | "hypothesis" | "attempt" | "outcome";
	id: string;
	ts: string;
	signal: {
		key: string;
		signals: string[];
		error_signature: string | null;
	};
	outcome?: {
		status: "success" | "failed";
		score: number;
		note: string;
		observed?: { current_signals?: string[] };
		predictive?: { signal_clarity?: number; trajectory_trend?: number };
	};
	gene?: { id: string | null; category: string | null };
	mutation?: { id: string; category: string; risk_level?: string };
}

export interface EvolverSpawnOptions {
	command: string;
	args?: string[];
	stdin?: string;
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
}

export interface EvolverSpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

export interface EvolverDetection {
	path: string;
	version: string;
}
