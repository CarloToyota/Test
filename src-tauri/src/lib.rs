//! Tauri shell around the platform-agnostic `audio_engine`.
//!
//! The engine thread hands events to a tokio channel; an async task on Tauri's runtime
//! emits them to the webview. IPC serialization therefore never runs on the DSP thread.

pub mod audio_engine;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use audio_engine::capture::{self, CaptureHandle, CaptureInfo, InputDevice};
use audio_engine::instrument::ALL_INSTRUMENTS;
use audio_engine::{EngineOutput, Instrument, InstrumentInfo};

pub const NOTE_EVENT: &str = "note-event";
pub const STATUS_EVENT: &str = "engine-status";
pub const STOPPED_EVENT: &str = "engine-stopped";

#[derive(Default)]
struct AppState {
    capture: Mutex<Option<CaptureHandle>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoppedPayload {
    dropped_samples: u64,
}

#[tauri::command]
fn get_instruments() -> Vec<InstrumentInfo> {
    ALL_INSTRUMENTS.iter().map(|i| i.info()).collect()
}

#[tauri::command]
fn list_input_devices() -> Result<Vec<InputDevice>, String> {
    capture::list_input_devices()
}

#[tauri::command]
fn start_engine(
    app: AppHandle,
    state: State<'_, AppState>,
    instrument: Instrument,
    device_id: Option<String>,
) -> Result<CaptureInfo, String> {
    let mut slot = state.capture.lock().map_err(|_| "engine state poisoned")?;
    if let Some(old) = slot.take() {
        old.stop();
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<EngineOutput>();
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(output) = rx.recv().await {
            let result = match output {
                EngineOutput::Note(e) => emitter.emit(NOTE_EVENT, e),
                EngineOutput::Status(s) => emitter.emit(STATUS_EVENT, s),
            };
            if let Err(e) = result {
                eprintln!("[band-transcriber] emit failed: {e}");
            }
        }
    });

    // `UnboundedSender::send` never blocks, so the engine thread never waits on IPC.
    let (handle, info) = capture::start(device_id, instrument, move |o| {
        let _ = tx.send(o);
    })?;
    *slot = Some(handle);
    Ok(info)
}

#[tauri::command]
fn stop_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let handle = state.capture.lock().map_err(|_| "engine state poisoned")?.take();
    if let Some(h) = handle {
        let dropped_samples = h.dropped_samples();
        h.stop();
        let _ = app.emit(STOPPED_EVENT, StoppedPayload { dropped_samples });
    }
    Ok(())
}

#[tauri::command]
fn set_instrument(state: State<'_, AppState>, instrument: Instrument) -> Result<(), String> {
    if let Some(h) = state.capture.lock().map_err(|_| "engine state poisoned")?.as_ref() {
        h.set_instrument(instrument);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_instruments,
            list_input_devices,
            start_engine,
            stop_engine,
            set_instrument
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.app_handle().state::<AppState>();
                let handle = state.capture.lock().ok().and_then(|mut slot| slot.take());
                drop(handle);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Band Transcriber");
}
