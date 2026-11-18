// Web Audio metronome with look-ahead scheduling (sample-accurate clicks, jitter-free).
//
// The click is band-limited noise centred at 3.5-5 kHz. That is above the engine's
// 2.2 kHz low-pass and has no pitch, so the transcriber ignores it even through
// speakers. Headphones are still best.

import { audioContext, perfAt, resumeAudio } from "./audio";

export interface MetronomeTiming {
  /** performance.now() time of the first click (the count-in downbeat). */
  firstBeatPerf: number;
  /** AudioContext time of the first click. */
  firstBeatTime: number;
  beatMs: number;
}

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

export class Metronome {
  private noise: AudioBuffer | null = null;
  private timer: number | null = null;
  private nextBeatTime = 0;
  private beatIndex = 0;
  /** Accent per click in a bar: 2 downbeat, 1 group start, 0 other. */
  private pattern: number[] = [2, 0, 0, 0];
  private beatS = 0.5;
  private audible = true;
  private volume = 0.6;

  private noiseBuffer(): AudioBuffer {
    if (!this.noise) {
      const c = audioContext();
      const len = Math.floor(c.sampleRate * 0.03);
      this.noise = c.createBuffer(1, len, c.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  /** Must be called from a user gesture. `bpm` counts clicks. */
  async start(bpm: number, pattern: number[], audible: boolean): Promise<MetronomeTiming> {
    const c = await resumeAudio();
    this.stop();
    this.pattern = pattern.length ? pattern : [2];
    this.beatS = 60 / bpm;
    this.audible = audible;
    this.beatIndex = 0;
    this.nextBeatTime = c.currentTime + 0.15;
    const firstBeatTime = this.nextBeatTime;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    return { firstBeatPerf: perfAt(firstBeatTime), firstBeatTime, beatMs: this.beatS * 1000 };
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

  private schedule(): void {
    const c = audioContext();
    while (this.nextBeatTime < c.currentTime + LOOKAHEAD_S) {
      if (this.audible) this.click(this.nextBeatTime, this.pattern[this.beatIndex % this.pattern.length]);
      this.nextBeatTime += this.beatS;
      this.beatIndex++;
    }
  }

  /** One click at `time`; also used by playback for its metronome. */
  click(time: number, accent: number, volume = this.volume): void {
    const c = audioContext();
    const src = c.createBufferSource();
    src.buffer = this.noiseBuffer();
    const band = c.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = accent === 2 ? 5200 : accent === 1 ? 4400 : 3600;
    band.Q.value = 2.5;
    const gain = c.createGain();
    const peak = (accent === 2 ? 1.0 : accent === 1 ? 0.8 : 0.6) * volume * 3;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.025);
    src.connect(band).connect(gain).connect(c.destination);
    src.start(time);
    src.stop(time + 0.03);
  }
}
