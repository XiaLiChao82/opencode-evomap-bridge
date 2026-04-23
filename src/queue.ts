import type { EvoMapConfig, RawToolSignal } from "./types.ts";

export class SignalQueue {
	private readonly signals: RawToolSignal[] = [];
	private draining = false;

	constructor(
		private readonly config: EvoMapConfig,
		private readonly onSignal: (signal: RawToolSignal) => Promise<void>,
	) {}

	push(signal: RawToolSignal): void {
		this.signals.push(signal);
		if (!this.draining) {
			this.draining = true;
			queueMicrotask(() => {
				void this.drain();
			});
		}
	}

	private async drain(): Promise<void> {
		while (this.signals.length > 0) {
			const signal = this.signals.shift();
			if (!signal) {
				continue;
			}
			try {
				await this.onSignal(signal);
			} catch (error) {
				if (this.config.debug) {
					console.warn("[EvoMapBridge] signal processing failed", error);
				}
			}
		}
		this.draining = false;
	}
}
