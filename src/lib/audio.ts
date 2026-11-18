// One AudioContext for the metronome and playback, so both share a clock.

let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: "interactive" });
  return ctx;
}

/** Must be called from a user gesture the first time (browsers block audio otherwise). */
export async function resumeAudio(): Promise<AudioContext> {
  const c = audioContext();
  if (c.state !== "running") await c.resume();
  return c;
}

/** Map an AudioContext time to performance.now(), including output latency. */
export function perfAt(contextTime: number): number {
  const c = audioContext();
  const ts = c.getOutputTimestamp?.();
  if (ts && ts.contextTime !== undefined && ts.performanceTime && ts.performanceTime > 0) {
    return ts.performanceTime + (contextTime - ts.contextTime) * 1000;
  }
  const outputLatency = (c.outputLatency || 0) + (c.baseLatency || 0);
  return performance.now() + (contextTime - c.currentTime + outputLatency) * 1000;
}
