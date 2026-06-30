//! GPU device initialization using wgpu.
//! Prefers D3D12 on Windows, falls back to Vulkan.

use std::sync::OnceLock;
use wgpu::{Adapter, Device, Queue};

static GPU_STATE: OnceLock<GpuState> = OnceLock::new();

pub struct GpuState {
    pub device: Device,
    pub queue: Queue,
    pub adapter_name: String,
    pub backend: String,
}

/// Initialize the GPU. Idempotent — subsequent calls return cached info.
pub fn initialize() -> std::result::Result<String, String> {
    // OnceLock::get_or_try_init is nightly-only; do the fallible init by hand.
    if GPU_STATE.get().is_none() {
        let state = create_gpu_state()?;
        // If another thread won the race, that's fine — keep the existing one.
        let _ = GPU_STATE.set(state);
    }
    let state = GPU_STATE
        .get()
        .ok_or_else(|| "GPU state unavailable after initialization".to_string())?;
    Ok(format!(
        r#"{{"adapter":"{}","backend":"{}"}}"#,
        state.adapter_name, state.backend
    ))
}

pub fn get_state() -> Option<&'static GpuState> {
    GPU_STATE.get()
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

    Ok(GpuState {
        device,
        queue,
        adapter_name,
        backend,
    })
}
