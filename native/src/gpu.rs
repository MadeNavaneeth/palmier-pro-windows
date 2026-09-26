//! GPU device initialization using wgpu.
//! Prefers D3D12 on Windows, falls back to Vulkan.
//!
//! The device, its queue and the render pipeline that needs it are one unit in
//! a *resettable* slot rather than a `OnceLock`. A `OnceLock` cannot be
//! cleared, so a device that wgpu loses once — a TDR, a driver reset, device
//! removal — is retained for the rest of the process, and the first
//! `compositeFrameGpu` after that would fail forever with no way back. The slot
//! is the thing that makes recovery possible; the two callbacks below are what
//! tell us recovery is needed.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use wgpu::{Adapter, Device, Queue};

use crate::pipeline::CompositorPipeline;

/// Stable prefix on every lost-device failure the addon reports.
///
/// This string is the whole cross-language contract for device loss. The addon
/// cannot push an event into the renderer, and the caller has to be able to
/// tell "recoverable, retry the next frame" from "this build has no GPU, stop
/// asking" without parsing prose. `preview-compositor.ts` matches on it, so
/// changing it is a breaking change to that module.
pub const DEVICE_LOST_MARKER: &str = "PALMIER_GPU_DEVICE_LOST";

pub struct GpuState {
    pub device: Device,
    pub queue: Queue,
    /// Owned with the device, not beside it. A pipeline is bound to the device
    /// that compiled it, so a fresh device and a fresh pipeline have to be
    /// published as one or the first frame after recovery uses a pipeline with
    /// no device behind it.
    pub pipeline: CompositorPipeline,
    pub adapter_name: String,
    pub backend: String,
}

/// The device to composite this frame with, or the reason there isn't one.
pub enum Composite {
    /// A live device and the pipeline built on it.
    Ready(Arc<GpuState>),
    /// No device has ever been created, or none is available. The caller falls
    /// back to the CPU compositor, which is what a machine with no usable GPU
    /// has always done, and what `--mcp-server` mode always does because it
    /// never calls `gpuInit()`.
    Absent,
    /// A device existed and was lost. Carries the driver's own words, because
    /// "Unknown" versus "the adapter disappeared" is the difference between
    /// worth retrying and worth telling the user about.
    Lost(String),
}

/// The live device, shared so a pipeline is never split from its device.
static GPU_STATE: RwLock<Option<Arc<GpuState>>> = RwLock::new(None);

/// Set from wgpu's device-lost callback and, for internal errors, from its
/// uncaptured-error handler.
static DEVICE_LOST: AtomicBool = AtomicBool::new(false);

/// Why the device was lost, first report wins.
static DEVICE_LOST_REASON: Mutex<Option<String>> = Mutex::new(None);

/// Bumped for every device created. Both wgpu callbacks carry the generation
/// of the device they were installed on, so a late callback from a device that
/// has already been replaced cannot mark its healthy successor as lost.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Whether the single automatic rebuild allowed after a loss has been spent.
static RECOVERY_SPENT: AtomicBool = AtomicBool::new(false);

/// Initialize the GPU, or re-initialize it if the current device was lost.
///
/// Idempotent while the device is healthy: subsequent calls return cached info.
pub fn initialize() -> std::result::Result<String, String> {
    let state = initialize_state()?;
    Ok(adapter_json(&state.adapter_name, &state.backend))
}

/// `initialize`, but handing back the device itself. The napi entry point only
/// wants the adapter string; a test (or anything that composites directly) wants
/// the device and the pipeline built on it.
pub fn initialize_state() -> std::result::Result<Arc<GpuState>, String> {
    if let Some(state) = get_state() {
        return Ok(state);
    }
    let fresh = Arc::new(create_gpu_state()?);
    // If another thread won the race, that's fine — keep the existing one.
    let mut slot = write_slot();
    Ok(slot.get_or_insert(fresh).clone())
}

/// The live device, or None when there is none or the one we had was lost.
///
/// `None` is the signal the CPU fallback already keys on, so a lost device
/// degrades to the CPU compositor until `initialize` builds a new one.
pub fn get_state() -> Option<Arc<GpuState>> {
    if is_lost() {
        // Drop the dead device *and* its pipeline here, not lazily: they are
        // one allocation's worth of GPU objects and nobody else can.
        drop(write_slot().take());
        return None;
    }
    read_slot().clone()
}

/// The device a frame should composite on, rebuilding it once if the last one
/// was lost.
///
/// One rebuild attempt, not one per frame: `request_adapter` plus
/// `request_device` is a multi-millisecond D3D12 call, and a GPU that is gone
/// for good would otherwise pay it on every frame to reach the same answer.
/// After that one attempt the loss keeps being reported until `initialize()`
/// runs again, which is what the renderer's `gpuInit()` does — so a user who
/// restarts the driver gets the compositor back.
pub fn state_for_composite() -> Composite {
    if !is_lost() {
        return match get_state() {
            Some(state) => Composite::Ready(state),
            None => Composite::Absent,
        };
    }

    let reason = lost_reason().unwrap_or_else(|| "no reason reported".to_string());
    if !RECOVERY_SPENT.swap(true, Ordering::AcqRel) && initialize().is_ok() {
        if let Some(state) = get_state() {
            return Composite::Ready(state);
        }
    }
    Composite::Lost(reason)
}

/// Whether the current device has been lost. Checked, not blocked on: a thread
/// that read this a moment before the loss is still holding a valid handle to
/// a device that is about to stop answering, so the failure it reports is the
/// one that triggers recovery on the *next* frame.
pub fn is_lost() -> bool {
    DEVICE_LOST.load(Ordering::Acquire)
}

/// What the driver said about the loss, if it said anything.
pub fn lost_reason() -> Option<String> {
    lock(&DEVICE_LOST_REASON).clone()
}

/// The failure to report for a lost device: a stable marker the JS side can
/// branch on, then the driver's own words.
pub fn device_lost_message(reason: &str) -> String {
    format!("{DEVICE_LOST_MARKER}: {reason}")
}

fn create_gpu_state() -> std::result::Result<GpuState, String> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN,
        ..Default::default()
    });

    let adapter: Adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))
    .ok_or_else(|| "No suitable GPU adapter found".to_string())?;

    let info = adapter.get_info();
    let adapter_name = info.name.clone();
    let backend = format!("{:?}", info.backend);

    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("palmier-compositor"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            ..Default::default()
        },
        None,
    ))
    .map_err(|e| format!("Device request failed: {e}"))?;

    // Before the pipeline: a device can be lost between here and the first
    // frame, and watching costs nothing.
    watch_for_loss(&device);
    let pipeline = CompositorPipeline::new(&device);

    Ok(GpuState {
        device,
        queue,
        pipeline,
        adapter_name,
        backend,
    })
}

/// Install the two handlers that turn "the GPU went away" from a process abort
/// into a reportable, recoverable state.
///
/// Both are needed, and the second is not optional:
///
/// - `set_device_lost_callback` is the first-class signal. wgpu fires it for a
///   TDR, a driver reset and device removal.
/// - `on_uncaptured_error` is not optional *at all*. With no handler installed
///   wgpu's default is to **panic** on any error
///   (`backend/wgpu_core.rs::default_error_handler`), and a panic unwinding out
///   of a napi callback aborts the host process rather than raising a
///   catchable error — the same trap `validate_canvas` in `lib.rs` documents.
///   Installing it is what makes "the driver returned an error" a value this
///   process can report instead of a `0xC0000409` crash dialog.
fn watch_for_loss(device: &wgpu::Device) {
    let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    DEVICE_LOST.store(false, Ordering::Release);
    *lock(&DEVICE_LOST_REASON) = None;
    RECOVERY_SPENT.store(false, Ordering::Release);

    device.set_device_lost_callback(move |reason, message| {
        record_loss(generation, format!("device lost ({reason:?}): {message}"));
    });

    device.on_uncaptured_error(Box::new(move |err| {
        // Only an internal error means the device itself is gone; validation
        // and out-of-memory are this caller's bugs and are reported per call.
        if let wgpu::Error::Internal { description, .. } = &err {
            record_loss(generation, format!("uncaptured GPU error: {description}"));
        }
        log::error!("[gpu] uncaptured wgpu error: {err}");
    }));
}

/// Mark the current device lost, unless the callback came from one that has
/// already been replaced.
fn record_loss(callback_generation: u64, message: String) {
    if GENERATION.load(Ordering::Acquire) != callback_generation {
        return;
    }
    log::error!("[gpu] {message}");
    let mut reason = lock(&DEVICE_LOST_REASON);
    if reason.is_none() {
        *reason = Some(message);
    }
    // Released last, so a reader that sees the flag also sees the reason.
    DEVICE_LOST.store(true, Ordering::Release);
}

fn adapter_json(adapter_name: &str, backend: &str) -> String {
    format!(r#"{{"adapter":"{adapter_name}","backend":"{backend}"}}"#)
}

// A poisoned lock here means a panic unwound while the device slot was held.
// Losing the cached device is recoverable by definition — that is what this
// module is for — so recover the contents rather than propagating the poison
// into every future frame.
fn read_slot() -> RwLockReadGuard<'static, Option<Arc<GpuState>>> {
    GPU_STATE.read().unwrap_or_else(|e| e.into_inner())
}

fn write_slot() -> RwLockWriteGuard<'static, Option<Arc<GpuState>>> {
    GPU_STATE.write().unwrap_or_else(|e| e.into_inner())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The JS side greps for this string to tell a lost device from a build
    /// with no GPU, so its shape is a contract, not a formatting choice.
    #[test]
    fn the_device_lost_message_leads_with_the_marker_and_keeps_the_reason() {
        let message = device_lost_message("device lost (Unknown): DXGI_ERROR_DEVICE_RESET");

        assert!(
            message.starts_with(DEVICE_LOST_MARKER),
            "the marker has to be findable without parsing prose: {message}"
        );
        assert!(message.contains("DXGI_ERROR_DEVICE_RESET"), "{message}");
    }

    /// No device yet is the state `--mcp-server` mode and every CI machine are
    /// in, and it has to stay a silent CPU-fallback rather than an error: the
    /// preview was never the GPU's to begin with.
    #[test]
    fn a_process_that_never_built_a_device_is_absent_rather_than_lost() {
        // Deterministic: the ignored device tests are the only thing that can
        // ever create a device, and `cargo test` does not run them.
        assert!(matches!(state_for_composite(), Composite::Absent));
    }

    /// Device-free as a run: these statics are only written by a real device's
    /// callbacks, so on a machine with no GPU both are trivially consistent.
    /// The point is that "not lost" and "no reason" agree, because
    /// `state_for_composite` reads them in that order.
    #[test]
    fn a_healthy_process_reports_neither_a_loss_nor_a_reason() {
        assert!(!is_lost());
        assert_eq!(lost_reason(), None);
    }

    #[test]
    fn the_adapter_json_keeps_the_shape_the_main_process_parses() {
        // system.ts `JSON.parse`s this into `{ adapter, backend }`.
        let json = adapter_json("Test Adapter", "Dx12");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["adapter"], "Test Adapter");
        assert_eq!(parsed["backend"], "Dx12");
    }
}
