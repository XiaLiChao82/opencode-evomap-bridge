import type { EvoMapConfig, ExecutionAdvisory, Observation, ToolName } from "./types.ts";
import { nowIso, stableHash } from "./util.ts";

export const EVOMAP_SENTINEL = "<!-- evomap-bridge:advisory -->";

export function toAdvisory(
	observation: Observation,
	config: EvoMapConfig,
	source: "session" | "project",
): ExecutionAdvisory {
	return {
		id: stableHash(`${observation.id}:${source}`),
		tool: observation.tool,
		message: observation.message,
		observationId: observation.id,
		createdAt: nowIso(),
		lastUsedAt: null,
		useCount: 0,
		maxUses: config.maxAdvisoryUses,
		cooldownUntil: null,
		pathHints: observation.pathHints,
		source,
	};
}

export function pickAdvisories(
	tool: ToolName,
	advisories: ExecutionAdvisory[],
	config: EvoMapConfig,
	isoNow: string,
): ExecutionAdvisory[] {
	const now = Date.parse(isoNow);
	return advisories
		.filter((advisory) => advisory.tool === tool)
		.filter((advisory) => advisory.useCount < advisory.maxUses)
		.filter((advisory) => {
			if (!advisory.cooldownUntil) {
				return true;
			}
			return Date.parse(advisory.cooldownUntil) <= now;
		})
		.slice(0, config.maxAdvisoriesPerCall);
}

export function markAdvisoryUsed(
	advisory: ExecutionAdvisory,
	config: EvoMapConfig,
	isoNow: string,
): ExecutionAdvisory {
	return {
		...advisory,
		useCount: advisory.useCount + 1,
		lastUsedAt: isoNow,
		cooldownUntil: new Date(
			Date.parse(isoNow) + config.advisoryCooldownMs,
		).toISOString(),
	};
}

export function renderAdvisories(advisories: ExecutionAdvisory[]): string | null {
	if (advisories.length === 0) {
		return null;
	}
	const lines = [
		EVOMAP_SENTINEL,
		"<evomap_advisory>",
		...advisories.map((advisory) => `- ${advisory.message}`),
		"</evomap_advisory>",
	];
	return lines.join("\n");
}

export function hasSyntheticSentinel(output: string): boolean {
	return output.includes(EVOMAP_SENTINEL);
}
