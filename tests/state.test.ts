import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.ts";
import { EvoMapState } from "../src/state.ts";
import type { EvolverGepInstruction, Observation } from "../src/types.ts";

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

	test("active instruction set/get roundtrip", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const state = new EvoMapState(directory, "project-1", defaultConfig);
			await state.initialize();

			const instruction: EvolverGepInstruction = {
				id: "inst-1",
				createdAt: new Date().toISOString(),
				sessionId: "session-1",
				projectId: "project-1",
				prompt: "Test instruction",
				geneId: "gene-1",
				source: "evolver.stdout",
				expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
			};

			await state.setActiveInstruction("session-1", instruction);
			const retrieved = await state.getActiveInstruction("session-1");

			expect(retrieved).not.toBeNull();
			expect(retrieved!.id).toBe("inst-1");
			expect(retrieved!.prompt).toBe("Test instruction");
			expect(retrieved!.geneId).toBe("gene-1");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("expired instruction returns null and clears", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const state = new EvoMapState(directory, "project-1", defaultConfig);
			await state.initialize();

			const instruction: EvolverGepInstruction = {
				id: "inst-expired",
				createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
				sessionId: "session-1",
				projectId: "project-1",
				prompt: "Expired instruction",
				geneId: null,
				source: "evolver.stdout",
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			};

			await state.setActiveInstruction("session-1", instruction);
			const retrieved = await state.getActiveInstruction("session-1");

			expect(retrieved).toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("use count tracking auto-clears after maxAdvisoryUses", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const state = new EvoMapState(directory, "project-1", defaultConfig);
			await state.initialize();

			const instruction: EvolverGepInstruction = {
				id: "inst-auto",
				createdAt: new Date().toISOString(),
				sessionId: "session-1",
				projectId: "project-1",
				prompt: "Auto-clear test",
				geneId: "gene-ac",
				source: "evolver.stdout",
				expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
			};

			await state.setActiveInstruction("session-1", instruction);

			for (let i = 0; i < defaultConfig.maxAdvisoryUses; i++) {
				await state.recordInstructionApplied("session-1", "inst-auto", `call-${i}`);
			}

			const after = await state.getActiveInstruction("session-1");
			expect(after).toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("lookup by toolCallId returns applied instruction", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const state = new EvoMapState(directory, "project-1", defaultConfig);
			await state.initialize();

			const instruction: EvolverGepInstruction = {
				id: "inst-lookup",
				createdAt: new Date().toISOString(),
				sessionId: "session-1",
				projectId: "project-1",
				prompt: "Lookup test",
				geneId: "gene-lu",
				mutationId: "mut-lu",
				source: "evolver.stdout",
				expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
			};

			await state.setActiveInstruction("session-1", instruction);
			await state.recordInstructionApplied("session-1", "inst-lookup", "call-abc");

			const applied = await state.getAppliedInstructionForCall("session-1", "call-abc");
			expect(applied).not.toBeNull();
			expect(applied!.instructionId).toBe("inst-lookup");
			expect(applied!.geneId).toBe("gene-lu");
			expect(applied!.mutationId).toBe("mut-lu");
			expect(applied!.toolCallIds).toContain("call-abc");

			const notFound = await state.getAppliedInstructionForCall("session-1", "call-nonexistent");
			expect(notFound).toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("clearActiveInstruction removes instruction", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "evomap-bridge-"));
		try {
			const state = new EvoMapState(directory, "project-1", defaultConfig);
			await state.initialize();

			const instruction: EvolverGepInstruction = {
				id: "inst-clear",
				createdAt: new Date().toISOString(),
				sessionId: "session-1",
				projectId: "project-1",
				prompt: "Clear test",
				geneId: null,
				source: "evolver.stdout",
				expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
			};

			await state.setActiveInstruction("session-1", instruction);
			await state.clearActiveInstruction("session-1");
			const retrieved = await state.getActiveInstruction("session-1");
			expect(retrieved).toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
