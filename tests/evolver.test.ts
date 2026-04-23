import { describe, expect, test } from "bun:test";
import { renderAdvisories } from "../src/advisory.ts";
import { defaultConfig } from "../src/config.ts";
import { deriveObservations } from "../src/evolver.ts";
import type { RawToolSignal } from "../src/types.ts";

function makeSignal(overrides: Partial<RawToolSignal>): RawToolSignal {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		sessionId: overrides.sessionId ?? "session-1",
		projectId: overrides.projectId ?? "project-1",
		tool: overrides.tool ?? "bash",
		callId: overrides.callId ?? crypto.randomUUID(),
		createdAt: overrides.createdAt ?? new Date().toISOString(),
		args: overrides.args ?? { command: "bun test" },
		pathHints: overrides.pathHints ?? [],
		result: {
			success: overrides.result?.success ?? false,
			exitCode: overrides.result?.exitCode ?? 1,
			durationMs: overrides.result?.durationMs ?? 100,
			outputDigest: overrides.result?.outputDigest ?? "digest-1",
			errorSnippet: overrides.result?.errorSnippet ?? "Command failed",
		},
	};
}

describe("deriveObservations", () => {
	test("emits repeat failure after threshold", () => {
		const signal = makeSignal({});
		const recentSignals = [makeSignal({ id: "a" }), makeSignal({ id: "b" }), signal];
		const observations = deriveObservations(signal, recentSignals, defaultConfig);
		expect(observations.some((item) => item.type === "repeat_failure")).toBe(true);
	});

	test("emits slow execution for long-running tools", () => {
		const signal = makeSignal({
			result: {
				success: true,
				exitCode: 0,
				durationMs: defaultConfig.slowExecutionMs + 1,
				outputDigest: "slow",
				errorSnippet: "",
			},
		});
		const observations = deriveObservations(signal, [signal], defaultConfig);
		expect(observations.some((item) => item.type === "slow_execution")).toBe(true);
	});
});

describe("renderAdvisories", () => {
	test("renders a sentinel-wrapped advisory block", () => {
		const rendered = renderAdvisories([
			{
				id: "adv-1",
				tool: "bash",
				message: "Avoid repeating the same failing bash command.",
				observationId: "obs-1",
				createdAt: new Date().toISOString(),
				lastUsedAt: null,
				useCount: 0,
				maxUses: 3,
				cooldownUntil: null,
				pathHints: [],
				source: "session",
			},
		]);

		expect(rendered).toContain("<!-- evomap-bridge:advisory -->");
		expect(rendered).toContain("Avoid repeating the same failing bash command.");
	});
});
