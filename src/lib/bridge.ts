// Typed access to the Rust engine. Outside Tauri (a plain browser running `npm run dev`)
// a scripted demo stands in, so the UI and renderer can be worked on without a mic.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DemoEngine, DEMO_INSTRUMENTS } from "./demo";
import type { CaptureInfo, EngineStatus, InputDevice, InstrumentId, InstrumentInfo, NoteEvent } from "./types";

export interface EngineHandlers {
  onNote: (e: NoteEvent) => void;
  onStatus: (s: EngineStatus) => void;
}

export interface EngineBridge {
  readonly isDemo: boolean;
  getInstruments(): Promise<InstrumentInfo[]>;
  listInputDevices(): Promise<InputDevice[]>;
  start(instrument: InstrumentId, deviceId: string | null): Promise<CaptureInfo>;
  stop(): Promise<void>;
  setInstrument(instrument: InstrumentId): Promise<void>;
  subscribe(handlers: EngineHandlers): Promise<UnlistenFn>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

class TauriBridge implements EngineBridge {
  readonly isDemo = false;
  getInstruments() {
    return invoke<InstrumentInfo[]>("get_instruments");
  }
  listInputDevices() {
    return invoke<InputDevice[]>("list_input_devices");
  }
  start(instrument: InstrumentId, deviceId: string | null) {
    return invoke<CaptureInfo>("start_engine", { instrument, deviceId });
  }
  stop() {
    return invoke<void>("stop_engine");
  }
  setInstrument(instrument: InstrumentId) {
    return invoke<void>("set_instrument", { instrument });
  }
  async subscribe({ onNote, onStatus }: EngineHandlers) {
    const offNote = await listen<NoteEvent>("note-event", (e) => onNote(e.payload));
    const offStatus = await listen<EngineStatus>("engine-status", (e) => onStatus(e.payload));
    return () => {
      offNote();
      offStatus();
    };
  }
}

class DemoBridge implements EngineBridge {
  readonly isDemo = true;
  private engine = new DemoEngine();
  async getInstruments() {
    return DEMO_INSTRUMENTS;
  }
  async listInputDevices(): Promise<InputDevice[]> {
    return [{ id: "demo", name: "Demo melody (no microphone)", isDefault: true }];
  }
  async start(instrument: InstrumentId) {
    return this.engine.start(instrument);
  }
  async stop() {
    this.engine.stop();
  }
  async setInstrument(instrument: InstrumentId) {
    this.engine.setInstrument(instrument);
  }
  async subscribe(handlers: EngineHandlers) {
    this.engine.listeners.add(handlers);
    return () => {
      this.engine.listeners.delete(handlers);
    };
  }
}

export const engine: EngineBridge = isTauri() ? new TauriBridge() : new DemoBridge();
