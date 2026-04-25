import { describe, expect, test } from "bun:test";
import { parseEvolverRunOutput, renderGepInstruction } from "../src/gep.ts";
import type { EvolverGepInstruction } from "../src/types.ts";

describe("parseEvolverRunOutput", () => {
	test("returns null for empty stdout", () => {
		const result = parseEvolverRunOutput("", {
			sessionId: "s1",
			projectId: "p1",
		});
		expect(result).toBeNull();
	});

	test("returns null for whitespace-only stdout", () => {
		const result = parseEvolverRunOutput("   \n\t  ", {
			sessionId: "s1",
			projectId: "p1",
		});
		expect(result).toBeNull();
	});

	test("plain text becomes prompt with null metadata", () => {
		const result = parseEvolverRunOutput("Prefer narrower file globs to reduce latency.", {
			sessionId: "s1",
			projectId: "p1",
		});
		expect(result).not.toBeNull();
		expect(result!.prompt).toBe("Prefer narrower file globs to reduce latency.");
		expect(result!.geneId).toBeNull();
		expect(result!.mutationId).toBeNull();
		expect(result!.riskLevel).toBeNull();
		expect(result!.source).toBe("evolver.stdout");
		expect(result!.sessionId).toBe("s1");
		expect(result!.projectId).toBe("p1");
	});

	test("extracts JSON metadata for geneId, mutationId, riskLevel", () => {
		const stdout = `Some preamble text
{"gene_id": "gene-42", "mutation_id": "mut-7", "risk_level": "high"}
Postamble`;
		const result = parseEvolverRunOutput(stdout, {
			sessionId: "s2",
			projectId: "p2",
		});
		expect(result).not.toBeNull();
		expect(result!.geneId).toBe("gene-42");
		expect(result!.mutationId).toBe("mut-7");
		expect(result!.riskLevel).toBe("high");
	});

	test("extracts prompt from GEP_PROTOCOL block", () => {
		const stdout = `Before block
<GEP_PROTOCOL>Apply the following strategy: reduce search scope</GEP_PROTOCOL>
After block`;
		const result = parseEvolverRunOutput(stdout, {
			sessionId: "s3",
			projectId: "p3",
		});
		expect(result).not.toBeNull();
		expect(result!.prompt).toBe("Apply the following strategy: reduce search scope");
	});

	test("extracts prompt from gep code fence", () => {
		const stdout = `Analysis complete
\`\`\`gep
Strategy: prioritize file-level reads over grep
\`\`\`
Done`;
		const result = parseEvolverRunOutput(stdout, {
			sessionId: "s4",
			projectId: "p4",
		});
		expect(result).not.toBeNull();
		expect(result!.prompt).toBe("Strategy: prioritize file-level reads over grep");
	});

	test("malformed stdout falls back to full stdout as prompt", () => {
		const stdout = "This is not JSON and has no GEP markers { broken";
		const result = parseEvolverRunOutput(stdout, {
			sessionId: "s5",
			projectId: "p5",
		});
		expect(result).not.toBeNull();
		expect(result!.prompt).toBe(stdout);
	});

	test("sets expiresAt roughly 30 minutes in the future", () => {
		const before = Date.now();
		const result = parseEvolverRunOutput("Some instruction", {
			sessionId: "s6",
			projectId: "p6",
		});
		const after = Date.now();
		expect(result).not.toBeNull();
		const expiresAt = Date.parse(result!.expiresAt);
		const thirtyMin = 30 * 60 * 1000;
		expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyMin - 1000);
		expect(expiresAt).toBeLessThanOrEqual(after + thirtyMin + 1000);
	});

	test("extracts camelCase JSON metadata fields", () => {
		const stdout = `{"geneId": "gene-cc", "mutationId": "mut-cc", "riskLevel": "medium"}`;
		const result = parseEvolverRunOutput(stdout, {
			sessionId: "s7",
			projectId: "p7",
		});
		expect(result).not.toBeNull();
		expect(result!.geneId).toBe("gene-cc");
		expect(result!.mutationId).toBe("mut-cc");
		expect(result!.riskLevel).toBe("medium");
	});
});

describe("renderGepInstruction", () => {
	test("renders instruction with full metadata", () => {
		const instruction: EvolverGepInstruction = {
			id: "inst-1",
			createdAt: new Date().toISOString(),
			sessionId: "s1",
			projectId: "p1",
			prompt: "Reduce grep scope to specific paths.",
			geneId: "gene-99",
			mutationId: "mut-42",
			riskLevel: "medium",
			source: "evolver.stdout",
			expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
		};
		const rendered = renderGepInstruction(instruction);
		expect(rendered).toContain("[EvoMap GEP Instruction]");
		expect(rendered).toContain("Reduce grep scope to specific paths.");
		expect(rendered).toContain("gene: gene-99");
		expect(rendered).toContain("mutation: mut-42");
		expect(rendered).toContain("risk: medium");
	});

	test("renders instruction with null metadata", () => {
		const instruction: EvolverGepInstruction = {
			id: "inst-2",
			createdAt: new Date().toISOString(),
			sessionId: "s2",
			projectId: "p2",
			prompt: "Prefer edit over write for small changes.",
			geneId: null,
			source: "evolver.stdout",
			expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
		};
		const rendered = renderGepInstruction(instruction);
		expect(rendered).toContain("[EvoMap GEP Instruction]");
		expect(rendered).toContain("Prefer edit over write for small changes.");
		expect(rendered).not.toContain("gene:");
		expect(rendered).not.toContain("mutation:");
		expect(rendered).not.toContain("risk:");
	});
});
