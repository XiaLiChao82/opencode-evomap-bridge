import type { EvolverDetection, EvolverSpawnOptions, EvolverSpawnResult } from "./types.ts";

let cachedDetection: EvolverDetection | null = null;
let detectionAttempted = false;
let cachedBinary = "";

export function resetDetectionCache(): void {
	cachedDetection = null;
	detectionAttempted = false;
	cachedBinary = "";
}

export async function detectEvolver(binary = "evolver"): Promise<EvolverDetection | null> {
	if (detectionAttempted && cachedBinary === binary) {
		return cachedDetection;
	}
	detectionAttempted = true;
	cachedBinary = binary;

	try {
		const whichProc = Bun.spawn(["which", binary], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const whichExit = await whichProc.exited;
		if (whichExit !== 0) {
			return null;
		}
		const binaryPath = (await new Response(whichProc.stdout).text()).trim();

		let version = "unknown";
		try {
			const proc = Bun.spawn([binary], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			const output = await new Response(proc.stdout).text();
			const match = output.match(/(\d+\.\d+\.\d+)/);
			if (match && match[1]) {
				version = match[1];
			}
		} catch {
			// version extraction failure is non-fatal
		}

		cachedDetection = { path: binaryPath, version };
		return cachedDetection;
	} catch (error) {
		console.warn("[EvoMapBridge/spawn] evolver detection failed", error);
		return null;
	}
}

export async function spawnEvolver(
	options: EvolverSpawnOptions,
	binary = "evolver",
): Promise<EvolverSpawnResult> {
	const {
		command,
		args = [],
		stdin,
		cwd,
		timeoutMs = 5000,
		env,
	} = options;

	const procArgs = [command, ...args];

	try {
		const proc = Bun.spawn([binary, ...procArgs], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: stdin ? "pipe" : undefined,
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
		});

		if (stdin && proc.stdin) {
			proc.stdin.write(new TextEncoder().encode(stdin));
			proc.stdin.end();
		}

		const timeoutPromise = new Promise<"timeout">((resolve) => {
			setTimeout(() => resolve("timeout"), timeoutMs);
		});

		const result = await Promise.race([
			(async () => {
				const exitCode = await proc.exited;
				const stdout = await new Response(proc.stdout).text();
				const stderr = await new Response(proc.stderr).text();
				return { stdout, stderr, exitCode, timedOut: false } as EvolverSpawnResult;
			})(),
			timeoutPromise,
		]);

		if (result === "timeout") {
			proc.kill();
			const stdout = await new Response(proc.stdout).text().catch(() => "");
			const stderr = await new Response(proc.stderr).text().catch(() => "");
			return {
				stdout,
				stderr,
				exitCode: null,
				timedOut: true,
			};
		}

		return result;
	} catch (error) {
		return {
			stdout: "",
			stderr: String(error),
			exitCode: null,
			timedOut: false,
		};
	}
}

export async function isEvolverAvailable(binary = "evolver"): Promise<boolean> {
	const detection = await detectEvolver(binary);
	return detection !== null;
}

export function getEvolverRoot(directory: string): string {
	return `${directory}/.evomap`;
}

export function getMemoryGraphPath(evolverRoot: string): string {
	return `${evolverRoot}/memory/evolution/memory_graph.jsonl`;
}
