import type { EvolverGepInstruction } from "./types.ts";
import { nowIso, stableHash } from "./util.ts";

const DEFAULT_TTL_MINUTES = 30;

interface ParseContext {
	sessionId: string;
	projectId: string;
}

/** Strip evolver startup banner and footer noise, keeping GEP protocol content only. */
function stripEvolverNoise(stdout: string): string {
	const lines = stdout.split("\n");
	let startIdx = 0;
	let endIdx = lines.length;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line !== undefined && (line.startsWith("GEP \u2014") || line.startsWith("GEP -"))) {
			startIdx = i;
			break;
		}
	}

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;
		const trimmed = line.trim();
		if (trimmed.startsWith("===") || trimmed.startsWith("Evolver finished") || trimmed.startsWith("Upstream:")) {
			endIdx = i;
			continue;
		}
		if (endIdx < lines.length && trimmed.length > 0) {
			break;
		}
	}

	return lines.slice(startIdx, endIdx).join("\n").trim();
}

function extractGepProtocolBlock(stdout: string): string | null {
	const tagMatch = stdout.match(
		/<GEP_PROTOCOL>([\s\S]*?)<\/GEP_PROTOCOL>/,
	);
	if (tagMatch?.[1]) {
		return tagMatch[1].trim();
	}

	const codeMatch = stdout.match(
		/```\s*gep\s*\n([\s\S]*?)```/,
	);
	if (codeMatch?.[1]) {
		return codeMatch[1].trim();
	}

	return null;
}

function extractJsonBlocks(text: string): string[] {
	const blocks: string[] = [];
	const stack: number[] = [];

	for (let i = 0; i < text.length; i++) {
		if (text[i] === "{") {
			stack.push(i);
		} else if (text[i] === "}" && stack.length > 0) {
			const start = stack.pop()!;
			if (stack.length === 0) {
				blocks.push(text.slice(start, i + 1));
			}
		}
	}

	return blocks;
}

function extractJsonMetadata(stdout: string): {
	geneId: string | null;
	geneCategory: string | null;
	mutationId: string | null;
	mutationCategory: string | null;
	riskLevel: string | null;
	capsuleIds: string[];
} {
	const found = {
		geneId: null as string | null,
		geneCategory: null as string | null,
		mutationId: null as string | null,
		mutationCategory: null as string | null,
		riskLevel: null as string | null,
		capsuleIds: [] as string[],
	};

	const flatBlocks = stdout.match(/\{[^{}]*\}/g) ?? [];
	const nestedBlocks = extractJsonBlocks(stdout);
	const jsonBlocks = [...flatBlocks, ...nestedBlocks];

	for (const block of jsonBlocks) {
		try {
			const parsed = JSON.parse(block) as Record<string, unknown>;
			if (
				typeof parsed.gene_id === "string" ||
				typeof parsed.geneId === "string" ||
				typeof parsed.mutation_id === "string" ||
				typeof parsed.mutationId === "string"
			) {
				return {
					geneId:
						(typeof parsed.gene_id === "string"
							? parsed.gene_id
							: typeof parsed.geneId === "string"
								? parsed.geneId
								: null) ?? null,
					geneCategory:
						(typeof parsed.gene_category === "string"
							? parsed.gene_category
							: typeof parsed.geneCategory === "string"
								? parsed.geneCategory
								: null) ?? null,
					mutationId:
						(typeof parsed.mutation_id === "string"
							? parsed.mutation_id
							: typeof parsed.mutationId === "string"
								? parsed.mutationId
								: null) ?? null,
					mutationCategory:
						(typeof parsed.mutation_category === "string"
							? parsed.mutation_category
							: typeof parsed.mutationCategory === "string"
								? parsed.mutationCategory
								: null) ?? null,
					riskLevel:
						(typeof parsed.risk_level === "string"
							? parsed.risk_level
							: typeof parsed.riskLevel === "string"
								? parsed.riskLevel
								: null) ?? null,
					capsuleIds: Array.isArray(parsed.capsule_ids)
						? (parsed.capsule_ids as string[])
						: Array.isArray(parsed.capsuleIds)
							? (parsed.capsuleIds as string[])
							: [],
				};
			}
		} catch {
			continue;
		}
	}

	if (found.geneId === null) {
		for (const block of jsonBlocks) {
			try {
				const parsed = JSON.parse(block) as Record<string, unknown>;
				if (parsed.type === "Gene" && typeof parsed.id === "string" && parsed.id.startsWith("gene_")) {
					found.geneId = parsed.id;
					found.geneCategory = typeof parsed.category === "string" ? parsed.category : null;
					break;
				}
			} catch {
				continue;
			}
		}
	}

	if (found.mutationId === null) {
		for (const block of jsonBlocks) {
			try {
				const parsed = JSON.parse(block) as Record<string, unknown>;
				if (parsed.type === "Mutation" && typeof parsed.id === "string" && parsed.id.startsWith("mut_")) {
					found.mutationId = parsed.id;
					found.mutationCategory = typeof parsed.category === "string" ? parsed.category : null;
					found.riskLevel = typeof parsed.risk_level === "string"
						? parsed.risk_level
						: typeof parsed.riskLevel === "string"
							? parsed.riskLevel
							: null;
					break;
				}
			} catch {
				continue;
			}
		}
	}

	return found;
}

export function parseEvolverRunOutput(
	stdout: string,
	context: ParseContext,
): EvolverGepInstruction | null {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const gepContent = extractGepProtocolBlock(trimmed);
	const prompt = gepContent ?? stripEvolverNoise(trimmed);

	const meta = extractJsonMetadata(trimmed);
	const now = nowIso();
	const expiresAt = new Date(
		Date.now() + DEFAULT_TTL_MINUTES * 60 * 1000,
	).toISOString();

	return {
		id: stableHash(`gep:${context.sessionId}:${now}`),
		createdAt: now,
		sessionId: context.sessionId,
		projectId: context.projectId,
		prompt,
		geneId: meta.geneId,
		geneCategory: meta.geneCategory,
		mutationId: meta.mutationId,
		mutationCategory: meta.mutationCategory,
		riskLevel: meta.riskLevel,
		capsuleIds: meta.capsuleIds,
		source: "evolver.stdout",
		expiresAt,
	};
}

export function renderGepInstruction(
	instruction: EvolverGepInstruction,
): string {
	const parts: string[] = [
		"[EvoMap GEP Instruction]",
		instruction.prompt,
	];

	if (instruction.geneId) {
		parts.push(`gene: ${instruction.geneId}`);
	}
	if (instruction.mutationId) {
		parts.push(`mutation: ${instruction.mutationId}`);
	}
	if (instruction.riskLevel) {
		parts.push(`risk: ${instruction.riskLevel}`);
	}

	return parts.join("\n");
}
