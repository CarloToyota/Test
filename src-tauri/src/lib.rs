//! Tauri shell around the platform-agnostic `audio_engine`.
//!
//! The engine thread hands events to a tokio channel; an async task on Tauri's runtime
//! emits them to the webview. IPC serialization therefore never runs on the DSP thread.

pub mod audio_engine;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use tauri_plugin_dialog::DialogExt;

use audio_engine::capture::{self, CaptureHandle, CaptureInfo, InputDevice, Recording};
use audio_engine::instrument::ALL_INSTRUMENTS;
use audio_engine::{EngineOutput, Instrument, InstrumentInfo};

pub const NOTE_EVENT: &str = "note-event";
pub const STATUS_EVENT: &str = "engine-status";
pub const STOPPED_EVENT: &str = "engine-stopped";

#[derive(Default)]
struct AppState {
    capture: Mutex<Option<CaptureHandle>>,
    /// Audio of the last finished session, for "Export test case".
    last_recording: Mutex<Option<Recording>>,
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
        let recording = h.stop();
        if let Ok(mut slot) = state.last_recording.lock() {
            *slot = Some(recording);
        }
        let _ = app.emit(STOPPED_EVENT, StoppedPayload { dropped_samples });
    }
    Ok(())
}

/// Show a native Save dialog and write `contents` there. Returns the path, or `None`
/// if the person cancelled. Async so the blocking dialog never runs on the main thread.
#[tauri::command]
async fn save_export(
    app: AppHandle,
    default_name: String,
    filter_name: String,
    extensions: Vec<String>,
    contents: Vec<u8>,
) -> Result<Option<String>, String> {
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&filter_name, &exts)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedFile {
    name: String,
    bytes: Vec<u8>,
}

/// Show a native Open dialog and return the chosen file's name and contents.
#[tauri::command]
async fn open_file(
    app: AppHandle,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<OpenedFile>, String> {
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let Some(path) = app.dialog().file().add_filter(&filter_name, &exts).blocking_pick_file() else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some(OpenedFile { name, bytes }))
}

/// Save the last session as a test case: `<folder>/<name>/recording.wav` + `session.json`.
#[tauri::command]
async fn export_test_case(
    app: AppHandle,
    folder_name: String,
    session_json: String,
) -> Result<Option<String>, String> {
    let wav = {
        let state = app.state::<AppState>();
        let slot = state.last_recording.lock().map_err(|_| "recording state poisoned")?;
        let rec = slot.as_ref().ok_or("No recording yet: record a take first.")?;
        if rec.samples.is_empty() {
            return Err("The last take has no audio.".into());
        }
        audio_engine::wav::encode_wav_i16(&rec.samples, rec.sample_rate)
    };
    let Some(parent) = app
        .dialog()
        .file()
        .set_title("Choose where to save the test case")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let safe: String = folder_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let dir = parent.into_path().map_err(|e| e.to_string())?.join(safe);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("recording.wav"), wav).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("session.json"), session_json).map_err(|e| e.to_string())?;
    Ok(Some(dir.display().to_string()))
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
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_instruments,
            list_input_devices,
            start_engine,
            stop_engine,
            set_instrument,
            save_export,
            open_file,
            export_test_case
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
