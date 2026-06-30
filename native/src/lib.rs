//! Palmier Compositor — GPU-accelerated video compositing engine.
//!
//! This native addon provides the real-time multi-track preview compositor
//! and the geometry/transform engine shared between preview and FFmpeg export.
//! Built with wgpu for cross-platform GPU acceleration on Windows (D3D12/Vulkan).

#[macro_use]
extern crate napi_derive;

mod compositor;
mod geometry;
mod gpu;
mod pipeline;

use napi::{Error, Result, Status};
use pipeline::GpuLayer;

/// Initialize the GPU device. Call once at app startup.
/// Returns a JSON string with adapter info (name, backend, driver).
#[napi]
pub fn gpu_init() -> Result<String> {
    match gpu::initialize() {
        Ok(info) => Ok(info),
        Err(e) => Err(Error::new(Status::GenericFailure, format!("GPU init failed: {e}"))),
    }
}

/// Composite a single frame from file-based layer descriptors (Phase 0-2 API).
/// Loads images from disk. Use `composite_frame_gpu` for real-time preview.
#[napi]
pub fn composite_frame(
    layers_json: String,
    output_width: u32,
    output_height: u32,
    _frame_index: f64,
) -> Result<Vec<u8>> {
    let layers: Vec<compositor::LayerDescriptor> = serde_json_parse(&layers_json)?;
    compositor::composite(&layers, output_width, output_height)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Composite error: {e}")))
}

/// GPU-accelerated compositing from pre-decoded RGBA buffers (Phase 3+ API).
///
/// `layers_json` — JSON array:
///   [{ "width": u32, "height": u32, "x": f32, "y": f32, "opacity": f32,
///      "rotation_deg": f32, "scale_x": f32, "scale_y": f32,
///      "anchor_x": f32, "anchor_y": f32 }]
///
/// `frame_buffers` — flat concatenation of all layers' RGBA data, in order.
///   Each layer's buffer is width*height*4 bytes.
///
/// Returns the composited RGBA buffer.
#[napi]
pub fn composite_frame_gpu(
    layers_json: String,
    frame_buffers: Vec<u8>,
    output_width: u32,
    output_height: u32,
) -> Result<Vec<u8>> {
    #[derive(serde::Deserialize)]
    struct GpuLayerDesc {
        width: u32,
        height: u32,
        x: f32,
        y: f32,
        opacity: f32,
        #[serde(default)]
        rotation_deg: f32,
        #[serde(default = "default_scale")]
        scale_x: f32,
        #[serde(default = "default_scale")]
        scale_y: f32,
        #[serde(default)]
        anchor_x: f32,
        #[serde(default)]
        anchor_y: f32,
        #[serde(default)]
        blend_mode: u32,
        #[serde(default)]
        wipe_mode: u32,
        #[serde(default = "default_progress")]
        wipe_progress: f32,
        #[serde(default)]
        wipe_softness: f32,
    }
    fn default_scale() -> f32 { 1.0 }
    fn default_progress() -> f32 { 1.0 }

    let descriptors: Vec<GpuLayerDesc> = serde_json_parse(&layers_json)?;

    // Split frame_buffers into per-layer slices
    let mut offset: usize = 0;
    let mut gpu_layers = Vec::with_capacity(descriptors.len());

    for desc in &descriptors {
        let layer_size = (desc.width * desc.height * 4) as usize;
        if offset + layer_size > frame_buffers.len() {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Buffer too small: need {} bytes for layer ({}x{}), have {} remaining",
                    layer_size, desc.width, desc.height, frame_buffers.len() - offset
                ),
            ));
        }
        let layer_data = frame_buffers[offset..offset + layer_size].to_vec();
        offset += layer_size;

        gpu_layers.push(GpuLayer {
            rgba_data: layer_data,
            width: desc.width,
            height: desc.height,
            x: desc.x,
            y: desc.y,
            opacity: desc.opacity,
            rotation_deg: desc.rotation_deg,
            scale_x: desc.scale_x,
            scale_y: desc.scale_y,
            anchor_x: desc.anchor_x,
            anchor_y: desc.anchor_y,
            blend_mode: desc.blend_mode,
            wipe_mode: desc.wipe_mode,
            wipe_progress: desc.wipe_progress,
            wipe_softness: desc.wipe_softness,
        });
    }

    // Try GPU path first, fall back to CPU
    if let Some(pipeline) = pipeline::get_or_create_pipeline() {
        let state = gpu::get_state().unwrap();
        pipeline
            .composite(&state.device, &state.queue, &gpu_layers, output_width, output_height)
            .map_err(|e| Error::new(Status::GenericFailure, format!("GPU composite: {e}")))
    } else {
        // CPU fallback — construct pixel-based composite without file loading
        cpu_composite_from_buffers(&gpu_layers, output_width, output_height)
    }
}

/// One W3C separable blend channel. Indices match composite.wgsl / blend-mode.ts.
fn blend_channel_cpu(cb: f32, cs: f32, mode: u32) -> f32 {
    match mode {
        1 => cb * cs,                                  // multiply
        2 => cb + cs - cb * cs,                        // screen
        3 => {                                         // overlay
            if cb <= 0.5 { 2.0 * cb * cs } else { 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs) }
        }
        4 => cb.min(cs),                               // darken
        5 => cb.max(cs),                               // lighten
        6 => {                                         // color-dodge
            if cb <= 0.0 { 0.0 } else if cs >= 1.0 { 1.0 } else { (cb / (1.0 - cs)).min(1.0) }
        }
        7 => {                                         // color-burn
            if cb >= 1.0 { 1.0 } else if cs <= 0.0 { 0.0 } else { 1.0 - ((1.0 - cb) / cs).min(1.0) }
        }
        8 => {                                         // hard-light
            if cs <= 0.5 { 2.0 * cs * cb } else { 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb) }
        }
        9 => {                                         // soft-light
            if cs <= 0.5 {
                cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
            } else {
                let d = if cb <= 0.25 { ((16.0 * cb - 12.0) * cb + 4.0) * cb } else { cb.sqrt() };
                cb + (2.0 * cs - 1.0) * (d - cb)
            }
        }
        10 => (cb - cs).abs(),                         // difference
        11 => cb + cs - 2.0 * cb * cs,                 // exclusion
        _ => cs,                                       // normal
    }
}

/// Wipe alpha mask for a pixel at normalized (u, v) in the layer. Mirrors the
/// shader. mode: 0=none,1=left,2=right,3=up,4=down. Returns 0..1.
fn wipe_mask_cpu(mode: u32, progress: f32, softness: f32, u: f32, v: f32) -> f32 {
    if mode == 0 {
        return 1.0;
    }
    let soft = softness.max(0.0001);
    // smoothstep(edge0, edge1, x)
    fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
        let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }
    match mode {
        1 => {
            // reveal from left: visible where u < progress
            let edge = progress;
            1.0 - smoothstep(edge - soft, edge + soft, u)
        }
        2 => {
            // reveal from right: visible where u > 1 - progress
            let edge = 1.0 - progress;
            smoothstep(edge - soft, edge + soft, u)
        }
        3 => {
            // reveal from top: visible where v < progress
            let edge = progress;
            1.0 - smoothstep(edge - soft, edge + soft, v)
        }
        4 => {
            // reveal from bottom: visible where v > 1 - progress
            let edge = 1.0 - progress;
            smoothstep(edge - soft, edge + soft, v)
        }
        _ => 1.0,
    }
}

/// CPU fallback compositor that works with pre-decoded RGBA buffers.
/// Mirrors the GPU shader: W3C compositing with per-layer blend modes,
/// starting from a transparent backdrop so parity holds with the GPU path.
fn cpu_composite_from_buffers(
    layers: &[GpuLayer],
    output_width: u32,
    output_height: u32,
) -> Result<Vec<u8>> {
    let pixel_count = (output_width * output_height) as usize;
    let mut buffer = vec![0u8; pixel_count * 4];

    for layer in layers {
        if layer.opacity <= 0.0 || layer.rgba_data.is_empty() {
            continue;
        }

        let lx = layer.x as i32;
        let ly = layer.y as i32;
        let lw = layer.width as i32;
        let lh = layer.height as i32;
        let mode = layer.blend_mode;

        for row in 0..lh {
            let dst_y = ly + row;
            if dst_y < 0 || dst_y >= output_height as i32 {
                continue;
            }
            for col in 0..lw {
                let dst_x = lx + col;
                if dst_x < 0 || dst_x >= output_width as i32 {
                    continue;
                }

                let src_offset = ((row * lw + col) * 4) as usize;
                if src_offset + 3 >= layer.rgba_data.len() {
                    continue;
                }

                let cs = [
                    layer.rgba_data[src_offset] as f32 / 255.0,
                    layer.rgba_data[src_offset + 1] as f32 / 255.0,
                    layer.rgba_data[src_offset + 2] as f32 / 255.0,
                ];
                // Wipe mask uses normalized layer coordinates.
                let u = if lw > 1 { col as f32 / (lw - 1) as f32 } else { 0.0 };
                let v = if lh > 1 { row as f32 / (lh - 1) as f32 } else { 0.0 };
                let mask = wipe_mask_cpu(layer.wipe_mode, layer.wipe_progress, layer.wipe_softness, u, v);
                let alpha_s = (layer.rgba_data[src_offset + 3] as f32 / 255.0) * layer.opacity * mask;
                if alpha_s <= 0.0 {
                    continue;
                }

                let dst_offset = ((dst_y as u32 * output_width + dst_x as u32) * 4) as usize;
                let cb = [
                    buffer[dst_offset] as f32 / 255.0,
                    buffer[dst_offset + 1] as f32 / 255.0,
                    buffer[dst_offset + 2] as f32 / 255.0,
                ];
                let alpha_b = buffer[dst_offset + 3] as f32 / 255.0;

                let alpha_o = alpha_s + alpha_b * (1.0 - alpha_s);
                if alpha_o <= 0.0001 {
                    continue;
                }

                for ch in 0..3 {
                    let b = blend_channel_cpu(cb[ch], cs[ch], mode);
                    let co = alpha_s * (1.0 - alpha_b) * cs[ch]
                        + alpha_s * alpha_b * b
                        + (1.0 - alpha_s) * alpha_b * cb[ch];
                    buffer[dst_offset + ch] = ((co / alpha_o) * 255.0).round().clamp(0.0, 255.0) as u8;
                }
                buffer[dst_offset + 3] = (alpha_o * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    Ok(buffer)
}

/// Compute the transform matrix for a layer (used by both preview and export).
/// Returns a JSON-encoded 3x3 affine matrix as [[f32; 3]; 3].
#[napi]
pub fn compute_transform(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation_deg: f64,
    scale_x: f64,
    scale_y: f64,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<String> {
    let matrix = geometry::affine_transform(
        x as f32,
        y as f32,
        width as f32,
        height as f32,
        rotation_deg as f32,
        scale_x as f32,
        scale_y as f32,
        anchor_x as f32,
        anchor_y as f32,
    );
    Ok(serde_json_serialize(&matrix))
}

/// Get the FFmpeg filter_complex geometry string for a given layer transform.
/// Used during export to produce bit-exact output matching the preview.
#[napi]
pub fn export_filter_geometry(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation_deg: f64,
    scale_x: f64,
    scale_y: f64,
) -> Result<String> {
    Ok(geometry::to_ffmpeg_filter(
        x as f32,
        y as f32,
        width as f32,
        height as f32,
        rotation_deg as f32,
        scale_x as f32,
        scale_y as f32,
    ))
}

// ─── Internal helpers ────────────────────────────────────────────────────────

fn serde_json_parse<T: serde::de::DeserializeOwned>(json: &str) -> Result<T> {
    serde_json::from_str(json)
        .map_err(|e| Error::new(Status::InvalidArg, format!("JSON parse error: {e}")))
}

fn serde_json_serialize<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
