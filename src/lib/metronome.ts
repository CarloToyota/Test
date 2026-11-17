// Web Audio metronome with look-ahead scheduling (sample-accurate clicks, jitter-free).
//
// The click is band-limited noise centred at 3.5-5 kHz. That is above the engine's
// 2.2 kHz low-pass and has no pitch, so the transcriber ignores it even through
// speakers. Headphones are still best.

export interface MetronomeTiming {
  /** performance.now() time of the first click (the count-in downbeat). */
  firstBeatPerf: number;
  beatMs: number;
}

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

export class Metronome {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private timer: number | null = null;
  private nextBeatTime = 0;
  private beatIndex = 0;
  private beatsPerMeasure = 4;
  private beatS = 0.5;
  private audible = true;
  private volume = 0.6;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      const len = Math.floor(this.ctx.sampleRate * 0.03);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.ctx;
  }

  /** Must be called from a user gesture (browsers block audio otherwise). */
  async start(bpm: number, beatsPerMeasure: number, audible: boolean): Promise<MetronomeTiming> {
    const ctx = this.ensureContext();
    if (ctx.state !== "running") await ctx.resume();
    this.stop();
    this.beatsPerMeasure = beatsPerMeasure;
    this.beatS = 60 / bpm;
    this.audible = audible;
    this.beatIndex = 0;
    this.nextBeatTime = ctx.currentTime + 0.15;
    const firstBeatPerf = this.perfAt(this.nextBeatTime);
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    return { firstBeatPerf, beatMs: this.beatS * 1000 };
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  setAudible(audible: boolean): void {
    this.audible = audible;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  /** Map an AudioContext time to performance.now(), including output latency. */
  private perfAt(contextTime: number): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime && ts.performanceTime > 0) {
      return ts.performanceTime + (contextTime - ts.contextTime) * 1000;
    }
    const outputLatency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return performance.now() + (contextTime - ctx.currentTime + outputLatency) * 1000;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    while (this.nextBeatTime < ctx.currentTime + LOOKAHEAD_S) {
      if (this.audible) this.click(this.nextBeatTime, this.beatIndex % this.beatsPerMeasure === 0);
      this.nextBeatTime += this.beatS;
      this.beatIndex++;
    }
  }

  private click(time: number, accent: boolean): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = accent ? 5200 : 3600;
    band.Q.value = 2.5;
    const gain = ctx.createGain();
    const peak = (accent ? 1.0 : 0.65) * this.volume * 3;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.025);
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start(time);
    src.stop(time + 0.03);
  }
}
