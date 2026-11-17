// Maps the Rust engine clock (ms of audio since capture start) onto performance.now().
//
// Each engine-status heartbeat says "I have processed audio up to engine time T", and it
// arrives at perf time P. IPC delay is always positive, so the smallest P - T seen is the
// best estimate of the offset. A tiny upward leak lets the estimate follow drift between
// the audio and system clocks (tens of ppm).

const LEAK_MS_PER_S = 0.2;

export class EngineClock {
  private offset = Number.POSITIVE_INFINITY;
  private lastUpdatePerf = 0;

  reset(): void {
    this.offset = Number.POSITIVE_INFINITY;
  }

  get synced(): boolean {
    return Number.isFinite(this.offset);
  }

  observe(engineMs: number, receivedPerf: number = performance.now()): void {
    const sample = receivedPerf - engineMs;
    if (!this.synced) {
      this.offset = sample;
    } else {
      const leaked = this.offset + ((receivedPerf - this.lastUpdatePerf) / 1000) * LEAK_MS_PER_S;
      this.offset = Math.min(leaked, sample);
    }
    this.lastUpdatePerf = receivedPerf;
  }

  toPerf(engineMs: number): number {
    return this.synced ? engineMs + this.offset : performance.now();
  }
}
