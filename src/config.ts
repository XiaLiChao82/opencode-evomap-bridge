import type { EvoMapConfig } from "./types.ts";

export const defaultConfig: EvoMapConfig = {
	enabled: true,
	maxRecentSignals: 50,
	maxSignalSummaryChars: 220,
	maxAdvisoriesPerCall: 2,
	maxAdvisoryUses: 3,
	advisoryCooldownMs: 2 * 60 * 1000,
	repeatFailureThreshold: 3,
	repeatSuccessThreshold: 2,
	slowExecutionMs: 10_000,
	projectPromotionThreshold: 2,
	internalErrorThreshold: 5,
	debug: false,
	evolverBinary: "evolver",
	evolverSpawnTimeoutMs: 5000,
	evolverFallbackToLocal: true,
};

export function resolveConfig(
	overrides?: Partial<EvoMapConfig> | undefined,
): EvoMapConfig {
	return {
		...defaultConfig,
		...overrides,
	};
}
