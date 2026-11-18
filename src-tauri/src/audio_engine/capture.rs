//! Microphone capture with cpal, plus the dedicated engine thread.
//!
//! Threads:
//! * **cpal callback thread** (real-time): downmixes to mono and pushes samples into a
//!   lock-free SPSC ring buffer. No locks, no allocation, no DSP.
//! * **engine thread** (one per stream, owns the `cpal::Stream`): pops samples, runs
//!   [`BandEngine`] and hands compact [`EngineOutput`] values to the caller's sink.
//!
//! Raw audio never leaves Rust.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize};
use serde::Serialize;

use super::engine::BandEngine;
use super::instrument::Instrument;
use super::types::EngineOutput;
use super::wav::f32_to_i16;

/// Requested hardware buffer, in frames. 1024 at 48 kHz is 21 ms. The analysis hop is
/// independent of this, so a smaller value (256 or 512) lowers latency further if the
/// device supports it.
pub const CAPTURE_BUFFER_FRAMES: u32 = 1024;

/// Driver-reported discontinuities in the current stream (see `CaptureHandle::xruns`).
static XRUNS: AtomicU64 = AtomicU64::new(0);

/// About 1.4 s of mono audio at 48 kHz: plenty of slack if the engine thread is descheduled.
const RING_CAPACITY: usize = 1 << 16;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub buffer_frames: Option<u32>,
    pub analysis_window: usize,
    pub hop: usize,
    pub band_low_hz: f32,
    pub band_high_hz: f32,
}

enum Command {
    SetInstrument(Instrument),
}

/// Longest stretch of a session kept for "Export test case" (16-bit mono: ~58 MB at 48 kHz).
pub const MAX_RECORDING_SECONDS: usize = 600;

/// The audio of a finished session, exactly as the engine heard it (mono, unfiltered).
pub struct Recording {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
}

/// A running capture. Dropping it stops the stream and joins the engine thread.
pub struct CaptureHandle {
    stop: Arc<AtomicBool>,
    commands: mpsc::Sender<Command>,
    dropped_samples: Arc<AtomicU64>,
    sample_rate: u32,
    thread: Option<JoinHandle<Vec<i16>>>,
}

impl CaptureHandle {
    pub fn set_instrument(&self, instrument: Instrument) {
        let _ = self.commands.send(Command::SetInstrument(instrument));
    }

    /// Samples lost because the engine thread fell behind (should stay 0).
    pub fn dropped_samples(&self) -> u64 {
        self.dropped_samples.load(Ordering::Relaxed)
    }

    /// Buffer discontinuities the audio driver reported. Many Windows drivers flag
    /// these spuriously; `dropped_samples` is what says whether audio was lost.
    pub fn xruns(&self) -> u64 {
        XRUNS.load(Ordering::Relaxed)
    }

    /// Stop capturing and return the session's audio.
    pub fn stop(mut self) -> Recording {
        Recording {
            samples: self.shutdown(),
            sample_rate: self.sample_rate,
        }
    }

    fn shutdown(&mut self) -> Vec<i16> {
        self.stop.store(true, Ordering::Release);
        self.thread
            .take()
            .and_then(|t| t.join().ok())
            .unwrap_or_default()
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "Unknown input".to_string())
}

fn device_id(device: &cpal::Device) -> Option<String> {
    device.id().ok().map(|id| id.to_string())
}

pub fn list_input_devices() -> Result<Vec<InputDevice>, String> {
    let host = cpal::default_host();
    let default_id = host.default_input_device().as_ref().and_then(device_id);
    let devices = host.input_devices().map_err(|e| e.to_string())?;
    Ok(devices
        .filter_map(|d| {
            let id = device_id(&d)?;
            Some(InputDevice {
                is_default: Some(&id) == default_id.as_ref(),
                name: device_name(&d),
                id,
            })
        })
        .collect())
}

fn find_device(device_id_wanted: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    match device_id_wanted {
        Some(wanted) => {
            let id = wanted
                .parse::<cpal::DeviceId>()
                .map_err(|e| format!("invalid device id {wanted:?}: {e}"))?;
            host.device_by_id(&id)
                .ok_or_else(|| format!("input device {wanted:?} not found"))
        }
        None => host
            .default_input_device()
            .ok_or_else(|| "no default input device (is a microphone connected and allowed?)".to_string()),
    }
}

/// Start capturing. `sink` runs on the engine thread for every output, so it must be
/// cheap and non-blocking (e.g. a channel send).
pub fn start<F>(
    device_id: Option<String>,
    instrument: Instrument,
    mut sink: F,
) -> Result<(CaptureHandle, CaptureInfo), String>
where
    F: FnMut(EngineOutput) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicU64::new(0));
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<CaptureInfo, String>>(1);

    let stop_thread = stop.clone();
    let dropped_thread = dropped.clone();

    let thread = std::thread::Builder::new()
        .name("band-audio-engine".into())
        .spawn(move || {
            // The stream is built here because `cpal::Stream` is not `Send` on every
            // platform; it lives and dies on this thread.
            let (stream, mut consumer, mut engine, info) =
                match open_stream(device_id.as_deref(), instrument, dropped_thread) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return Vec::new();
                    }
                };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(format!("failed to start input stream: {e}")));
                return Vec::new();
            }
            let max_recording = MAX_RECORDING_SECONDS * info.sample_rate as usize;
            let mut recording: Vec<i16> = Vec::with_capacity(info.sample_rate as usize * 60);
            let _ = ready_tx.send(Ok(info));

            let mut scratch = vec![0.0f32; 4096];
            let mut out: Vec<EngineOutput> = Vec::with_capacity(16);
            while !stop_thread.load(Ordering::Acquire) {
                while let Ok(cmd) = cmd_rx.try_recv() {
                    match cmd {
                        Command::SetInstrument(i) => engine.set_instrument(i, &mut out),
                    }
                }

                let available = consumer.slots().min(scratch.len());
                if available == 0 {
                    // Nothing buffered. Sleep for well under one analysis hop (5 ms).
                    for o in out.drain(..) {
                        sink(o);
                    }
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                if let Ok(chunk) = consumer.read_chunk(available) {
                    let (a, b) = chunk.as_slices();
                    scratch[..a.len()].copy_from_slice(a);
                    scratch[a.len()..a.len() + b.len()].copy_from_slice(b);
                    chunk.commit_all();
                    let block = &scratch[..available];
                    engine.process(block, &mut out);
                    let room = max_recording.saturating_sub(recording.len());
                    recording.extend(block.iter().take(room).map(|&x| f32_to_i16(x)));
                }
                for o in out.drain(..) {
                    sink(o);
                }
            }
            engine.flush(&mut out);
            for o in out.drain(..) {
                sink(o);
            }
            drop(stream);
            recording
        })
        .map_err(|e| format!("failed to spawn audio thread: {e}"))?;

    let info = ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "audio device did not respond".to_string())
        .and_then(|r| r);

    let mut handle = CaptureHandle {
        stop,
        commands: cmd_tx,
        dropped_samples: dropped,
        sample_rate: 0,
        thread: Some(thread),
    };
    match info {
        Ok(info) => {
            handle.sample_rate = info.sample_rate;
            Ok((handle, info))
        }
        Err(e) => {
            drop(handle);
            Err(e)
        }
    }
}

type Opened = (cpal::Stream, rtrb::Consumer<f32>, BandEngine, CaptureInfo);

fn open_stream(
    device_id: Option<&str>,
    instrument: Instrument,
    dropped: Arc<AtomicU64>,
) -> Result<Opened, String> {
    let device = find_device(device_id)?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("no usable input config: {e}"))?;
    let sample_format = supported.sample_format();

    let mut config: StreamConfig = supported.config();
    // On Windows, let WASAPI pick its buffer: a forced small one (often capped at
    // 10 ms) leaves no slack and produces discontinuities. Timing is unaffected either
    // way: notes are timestamped by sample count, not by when buffers arrive.
    let fixed = match supported.buffer_size() {
        SupportedBufferSize::Range { min, max } if !cfg!(target_os = "windows") => {
            Some(CAPTURE_BUFFER_FRAMES.clamp(*min, *max))
        }
        _ => None,
    };
    XRUNS.store(0, Ordering::Relaxed);
    config.buffer_size = fixed.map_or(BufferSize::Default, BufferSize::Fixed);

    let build = |config: StreamConfig| -> Result<(cpal::Stream, rtrb::Consumer<f32>), String> {
        let (producer, consumer) = rtrb::RingBuffer::<f32>::new(RING_CAPACITY);
        let stream = match sample_format {
            SampleFormat::F32 => build_typed::<f32>(&device, config, producer, dropped.clone()),
            SampleFormat::I16 => build_typed::<i16>(&device, config, producer, dropped.clone()),
            SampleFormat::I32 => build_typed::<i32>(&device, config, producer, dropped.clone()),
            SampleFormat::U16 => build_typed::<u16>(&device, config, producer, dropped.clone()),
            SampleFormat::I8 => build_typed::<i8>(&device, config, producer, dropped.clone()),
            SampleFormat::U8 => build_typed::<u8>(&device, config, producer, dropped.clone()),
            SampleFormat::F64 => build_typed::<f64>(&device, config, producer, dropped.clone()),
            other => Err(format!("unsupported sample format {other}")),
        }?;
        Ok((stream, consumer))
    };

    // Some backends reject a fixed buffer size even inside the advertised range.
    let (stream, consumer, buffer_frames) = match build(config) {
        Ok((s, c)) => (s, c, fixed),
        Err(first_err) if fixed.is_some() => {
            let mut fallback = config;
            fallback.buffer_size = BufferSize::Default;
            let (s, c) = build(fallback).map_err(|e| format!("{first_err}; fallback: {e}"))?;
            (s, c, None)
        }
        Err(e) => return Err(e),
    };

    let engine = BandEngine::new(config.sample_rate, instrument);
    let (band_low_hz, band_high_hz) = engine.band_hz();
    let info = CaptureInfo {
        device_name: device_name(&device),
        sample_rate: config.sample_rate,
        channels: config.channels,
        buffer_frames,
        analysis_window: engine.window(),
        hop: engine.hop(),
        band_low_hz,
        band_high_hz,
    };
    Ok((stream, consumer, engine, info))
}

fn build_typed<T>(
    device: &cpal::Device,
    config: StreamConfig,
    mut producer: rtrb::Producer<f32>,
    dropped: Arc<AtomicU64>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let inv = 1.0 / channels as f32;
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _info: &cpal::InputCallbackInfo| {
                // Real-time context: downmix and push only.
                let mut lost = 0u64;
                for frame in data.chunks_exact(channels) {
                    let mono = frame.iter().map(|&s| <f32 as Sample>::from_sample(s)).sum::<f32>() * inv;
                    if producer.push(mono).is_err() {
                        lost += 1;
                    }
                }
                if lost > 0 {
                    dropped.fetch_add(lost, Ordering::Relaxed);
                }
            },
            |err| {
                if err.kind() == cpal::ErrorKind::Xrun {
                    // Count, and log only the first and then every 500th.
                    let n = XRUNS.fetch_add(1, Ordering::Relaxed) + 1;
                    if n == 1 || n % 500 == 0 {
                        eprintln!("[band-audio-engine] audio driver reported {n} buffer discontinuities so far");
                    }
                } else {
                    eprintln!("[band-audio-engine] input stream error: {err}");
                }
            },
            None,
        )
        .map_err(|e| format!("failed to open input stream: {e}"))
}
