import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.ts";
import { EvoMapState } from "../src/state.ts";
import type { Observation } from "../src/types.ts";

describe("EvoMapState", () => {
	test("promotes project-eligible observations into project state", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const state = new EvoMapState(directory, "project-1", defaultConfig);
			await state.initialize();

			const observation: Observation = {
				id: "obs-1",
				type: "repeat_failure",
				tool: "bash",
				sessionId: "session-1",
				projectId: "project-1",
				fingerprint: "fingerprint-1",
				message: "Repeated failures detected.",
				confidence: 0.9,
				occurrenceCount: defaultConfig.projectPromotionThreshold,
				evidenceSignalIds: ["sig-1"],
				pathHints: [],
				createdAt: new Date().toISOString(),
				lastSeenAt: new Date().toISOString(),
				projectEligible: true,
			source: "local-rules",
			};

			await state.appendObservations("session-1", [observation]);

			const projectState = state.getProjectState();
			expect(projectState.observations).toHaveLength(1);
			expect(projectState.advisories).toHaveLength(1);
			expect(projectState.repoCandidates).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
