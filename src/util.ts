import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function stableHash(input: string): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function clampText(input: string | undefined, maxChars: number): string {
	if (!input) {
		return "";
	}
	if (input.length <= maxChars) {
		return input;
	}
	return `${input.slice(0, maxChars)}…`;
}

export function getProjectKey(directory: string): string {
	return stableHash(path.resolve(directory));
}

export function getDataDir(directory: string): string {
	return path.join(homedir(), ".opencode", "evomap-bridge", getProjectKey(directory));
}

export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

export async function readJsonFile<T>(
	filePath: string,
	fallback: T,
): Promise<T> {
	try {
		const raw = await readFile(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await ensureDir(path.dirname(filePath));
	await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function pathHintsFromArgs(raw: Record<string, unknown>): string[] {
	const hints = new Set<string>();
	for (const key of ["filePath", "path", "pattern", "command"]) {
		const value = raw[key];
		if (typeof value === "string" && value.trim()) {
			hints.add(value);
		}
	}
	return [...hints];
}
