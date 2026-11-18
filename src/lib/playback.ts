// Score playback: a small Web Audio synth per part, scheduled with look-ahead on the
// shared AudioContext clock, plus the position the on-screen playhead follows.

import { audioContext, resumeAudio } from "./audio";
import type { DocNote } from "./editor";
import { Metronome } from "./metronome";
import type { InstrumentId } from "./types";

export interface PlaybackPart {
  id: string;
  instrument: InstrumentId;
  /** Concert pitch, steps. */
  notes: DocNote[];
  volume: number;
  muted: boolean;
}

export interface PlayOptions {
  /** Seconds per 16th step. */
  stepSec: number;
  fromStep: number;
  endStep: number;
  /** Click on beats: steps per click and the accent pattern (see metronomePattern). */
  click?: { stepsPerBeat: number; pattern: number[]; stepsPerBar: number };
  /** AudioContext time at which `fromStep` sounds (default: right away). */
  startAt?: number;
}

interface Preset {
  waves: Array<[OscillatorType, number]>;
  /** Low-pass cutoff as a multiple of the note's frequency, at sustain and at the attack peak. */
  cutoff: number;
  cutoffPeak: number;
  q: number;
  attack: number;
  release: number;
  /** Vibrato depth in cents (applied after a short delay on long notes). */
  vibrato: number;
  gain: number;
}

// Broad-strokes timbres: enough to tell the parts apart and hear the harmony.
const PRESETS: Record<InstrumentId, Preset> = {
  flute: { waves: [["sine", 1], ["triangle", 0.35]], cutoff: 6, cutoffPeak: 8, q: 0.7, attack: 0.05, release: 0.08, vibrato: 14, gain: 0.5 },
  clarinet: { waves: [["square", 0.55], ["sine", 0.45]], cutoff: 5, cutoffPeak: 7, q: 0.8, attack: 0.03, release: 0.06, vibrato: 0, gain: 0.35 },
  altoSax: { waves: [["sawtooth", 0.7], ["square", 0.3]], cutoff: 4, cutoffPeak: 7, q: 1.2, attack: 0.03, release: 0.07, vibrato: 16, gain: 0.3 },
  tenorSax: { waves: [["sawtooth", 0.75], ["square", 0.25]], cutoff: 4, cutoffPeak: 6, q: 1.2, attack: 0.03, release: 0.07, vibrato: 14, gain: 0.32 },
  bariSax: { waves: [["sawtooth", 0.8], ["square", 0.2]], cutoff: 5, cutoffPeak: 7, q: 1, attack: 0.035, release: 0.08, vibrato: 8, gain: 0.34 },
  trumpet: { waves: [["sawtooth", 1]], cutoff: 5, cutoffPeak: 9, q: 1.5, attack: 0.025, release: 0.06, vibrato: 6, gain: 0.28 },
  frenchHorn: { waves: [["sawtooth", 0.6], ["sine", 0.4]], cutoff: 2.5, cutoffPeak: 4, q: 0.9, attack: 0.06, release: 0.12, vibrato: 0, gain: 0.4 },
  trombone: { waves: [["sawtooth", 1]], cutoff: 4, cutoffPeak: 7, q: 1.1, attack: 0.04, release: 0.09, vibrato: 0, gain: 0.32 },
  tuba: { waves: [["sawtooth", 0.6], ["sine", 0.4]], cutoff: 4, cutoffPeak: 6, q: 0.8, attack: 0.05, release: 0.1, vibrato: 0, gain: 0.5 },
};

const LOOKAHEAD_S = 0.25;
const TICK_MS = 25;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Player {
  /** Called every animation frame while playing with the current step; null when stopped. */
  onPosition: ((step: number | null) => void) | null = null;
  /** Called when playback reaches the end on its own. */
  onEnd: (() => void) | null = null;

  private timer: number | null = null;
  private raf = 0;
  private master: GainNode | null = null;
  private partGains = new Map<string, GainNode>();
  private parts: PlaybackPart[] = [];
  private cursors = new Map<string, number>();
  private opts: PlayOptions | null = null;
  private t0 = 0;
  private scheduledUntil = 0;
  private nextClickStep = 0;
  private metronome = new Metronome();
  private active: AudioScheduledSourceNode[] = [];

  get playing(): boolean {
    return this.timer !== null;
  }

  async play(parts: PlaybackPart[], opts: PlayOptions): Promise<void> {
    this.stop(false);
    const c = await resumeAudio();
    this.parts = parts;
    this.opts = opts;
    this.master = c.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(c.destination);
    for (const p of parts) {
      const g = c.createGain();
      g.gain.value = p.muted ? 0 : p.volume;
      g.connect(this.master);
      this.partGains.set(p.id, g);
      this.cursors.set(p.id, p.notes.findIndex((n) => n.e > opts.fromStep));
    }
    this.t0 = opts.startAt ?? c.currentTime + 0.08;
    this.scheduledUntil = opts.fromStep;
    if (opts.click) this.nextClickStep = Math.ceil(opts.fromStep / opts.click.stepsPerBeat) * opts.click.stepsPerBeat;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    const frame = () => {
      const step = this.position();
      if (step !== null && step >= opts.endStep) {
        this.stop(false);
        this.onEnd?.();
        return;
      }
      this.onPosition?.(step);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** Current step (what is being heard now), or null before the start. */
  position(): number | null {
    if (!this.opts) return null;
    const c = audioContext();
    const heard = c.currentTime - (c.outputLatency || 0);
    const step = this.opts.fromStep + (heard - this.t0) / this.opts.stepSec;
    return Math.max(this.opts.fromStep, step);
  }

  /** Stop and silence everything. Returns where playback was. */
  stop(notify = true): number | null {
    const at = this.playing ? this.position() : null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    cancelAnimationFrame(this.raf);
    const c = audioContext();
    for (const src of this.active) {
      try {
        src.stop(c.currentTime + 0.02);
      } catch {
        // already stopped
      }
    }
    this.active = [];
    if (this.master) {
      const m = this.master;
      m.gain.setTargetAtTime(0, c.currentTime, 0.01);
      setTimeout(() => m.disconnect(), 200);
    }
    this.master = null;
    this.partGains.clear();
    this.opts = null;
    if (notify) this.onPosition?.(null);
    return at;
  }

  setPartLevel(id: string, volume: number, muted: boolean): void {
    const g = this.partGains.get(id);
    if (g) g.gain.setTargetAtTime(muted ? 0 : volume, audioContext().currentTime, 0.02);
  }

  private timeOf(step: number): number {
    return this.t0 + (step - this.opts!.fromStep) * this.opts!.stepSec;
  }

  private schedule(): void {
    const o = this.opts;
    if (!o) return;
    const c = audioContext();
    const horizon = o.fromStep + (c.currentTime + LOOKAHEAD_S - this.t0) / o.stepSec;
    const until = Math.min(horizon, o.endStep);
    if (until <= this.scheduledUntil) return;

    for (const p of this.parts) {
      let i = this.cursors.get(p.id) ?? -1;
      if (i < 0) continue;
      while (i < p.notes.length && p.notes[i].s < until) {
        const n = p.notes[i];
        const s = Math.max(n.s, o.fromStep);
        if (n.e > s) this.voice(p, n.midi, this.timeOf(s), this.timeOf(n.e));
        i++;
      }
      this.cursors.set(p.id, i);
    }
    if (o.click) {
      while (this.nextClickStep < until) {
        const k = this.nextClickStep;
        const inBar = (k % o.click.stepsPerBar) / o.click.stepsPerBeat;
        this.metronome.click(this.timeOf(k), o.click.pattern[inBar] ?? 0, 0.45);
        this.nextClickStep += o.click.stepsPerBeat;
      }
    }
    this.scheduledUntil = until;
  }

  private voice(p: PlaybackPart, midi: number, start: number, end: number): void {
    const c = audioContext();
    const out = this.partGains.get(p.id);
    if (!out) return;
    const pr = PRESETS[p.instrument];
    const f = hz(midi);
    // Leave a hair of space so repeated notes re-articulate.
    const stopAt = Math.max(start + 0.04, end - 0.025);

    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = pr.q;
    const peak = Math.min(18000, f * pr.cutoffPeak);
    const sustainCut = Math.min(16000, f * pr.cutoff);
    filter.frequency.setValueAtTime(sustainCut * 0.6, start);
    filter.frequency.linearRampToValueAtTime(peak, start + pr.attack);
    filter.frequency.setTargetAtTime(sustainCut, start + pr.attack, 0.08);

    const env = c.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(pr.gain, start + pr.attack);
    env.gain.setTargetAtTime(pr.gain * 0.8, start + pr.attack, 0.1);
    env.gain.setValueAtTime(pr.gain * 0.8, stopAt);
    env.gain.setTargetAtTime(0, stopAt, pr.release / 3);
    filter.connect(env).connect(out);

    let lfo: OscillatorNode | null = null;
    let lfoGain: GainNode | null = null;
    if (pr.vibrato && end - start > 0.35) {
      lfo = c.createOscillator();
      lfo.frequency.value = 5.2;
      lfoGain = c.createGain();
      lfoGain.gain.setValueAtTime(0, start);
      lfoGain.gain.linearRampToValueAtTime(pr.vibrato, start + 0.3);
      lfo.connect(lfoGain);
      lfo.start(start);
      lfo.stop(stopAt + pr.release * 2);
      this.active.push(lfo);
    }
    for (const [type, level] of pr.waves) {
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      if (lfoGain) lfoGain.connect(osc.detune);
      const g = c.createGain();
      g.gain.value = level;
      osc.connect(g).connect(filter);
      osc.start(start);
      osc.stop(stopAt + pr.release * 2);
      osc.onended = () => {
        g.disconnect();
        const idx = this.active.indexOf(osc);
        if (idx >= 0) this.active.splice(idx, 1);
      };
      this.active.push(osc);
    }
  }
}
