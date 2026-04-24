import type { EvolverDetection, EvolverSpawnOptions, EvolverSpawnResult } from "./types.ts";
import { nowIso } from "./util.ts";

let cachedDetection: EvolverDetection | null = null;
let detectionAttempted = false;

export async function detectEvolver(): Promise<EvolverDetection | null> {
	if (detectionAttempted) {
		return cachedDetection;
	}
	detectionAttempted = true;

	try {
		const whichProc = Bun.spawn(["which", "evolver"], {
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
			const proc = Bun.spawn(["evolver"], {
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

export async function spawnEvolver(options: EvolverSpawnOptions): Promise<EvolverSpawnResult> {
	const {
		command,
		args = [],
		stdin,
		cwd,
		timeoutMs = 5000,
		env,
		retries = 0,
		retryDelayMs = 0,
	} = options;

	const procArgs = [command, ...args];

	let lastResult: EvolverSpawnResult | null = null;

	for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
		const startedAt = nowIso();
		const startedMs = Date.now();

		try {
			const proc = Bun.spawn(["evolver", ...procArgs], {
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

			const raced = await Promise.race([
				(async () => {
					const exitCode = await proc.exited;
					const stdout = await new Response(proc.stdout).text();
					const stderr = await new Response(proc.stderr).text();
					return { exitCode, stdout, stderr, timedOut: false };
				})(),
				timeoutPromise,
			]);

			if (raced === "timeout") {
				proc.kill();
				const stdout = await new Response(proc.stdout).text().catch(() => "");
				const stderr = await new Response(proc.stderr).text().catch(() => "");
				lastResult = {
					stdout,
					stderr,
					exitCode: null,
					timedOut: true,
					startedAt,
					finishedAt: nowIso(),
					durationMs: Date.now() - startedMs,
					attempt,
				};
			} else {
				lastResult = {
					stdout: raced.stdout,
					stderr: raced.stderr,
					exitCode: raced.exitCode,
					timedOut: raced.timedOut,
					startedAt,
					finishedAt: nowIso(),
					durationMs: Date.now() - startedMs,
					attempt,
				};
			}
		} catch (error) {
			lastResult = {
				stdout: "",
				stderr: String(error),
				exitCode: null,
				timedOut: false,
				startedAt,
				finishedAt: nowIso(),
				durationMs: Date.now() - startedMs,
				attempt,
			};
		}

		if (lastResult.exitCode === 0 && !lastResult.timedOut) {
			return lastResult;
		}

		if (attempt <= retries && retryDelayMs > 0) {
			await Bun.sleep(retryDelayMs);
		}
	}

	return (
		lastResult ?? {
			stdout: "",
			stderr: "spawn did not execute",
			exitCode: null,
			timedOut: false,
			startedAt: nowIso(),
			finishedAt: nowIso(),
			durationMs: 0,
			attempt: 0,
		}
	);
}

export async function isEvolverAvailable(): Promise<boolean> {
	const detection = await detectEvolver();
	return detection !== null;
}

export function getEvolverRoot(directory: string): string {
	return `${directory}/.evomap`;
}

export function getMemoryGraphPath(evolverRoot: string): string {
	return `${evolverRoot}/memory/evolution/memory_graph.jsonl`;
}
