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

use std::ops::Range;

use napi::bindgen_prelude::Buffer;
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
) -> Result<Buffer> {
    let layers: Vec<compositor::LayerDescriptor> = serde_json_parse(&layers_json)?;
    compositor::composite(&layers, output_width, output_height)
        .map(Buffer::from)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Composite error: {e}")))
}

/// GPU-accelerated compositing from pre-decoded RGBA buffers (Phase 3+ API).
///
/// `layers_json` — JSON array:
///   [{ "width": u32, "height": u32, "x": f32, "y": f32, "opacity": f32,
///      "rotation_deg": f32, "scale_x": f32, "scale_y": f32,
///      "anchor_x": f32, "anchor_y": f32 }]
///
/// `frame_buffers` — a Buffer holding the flat concatenation of all layers'
/// RGBA data, in order. Each layer's slice is width*height*4 bytes. This is a
/// Buffer (and the return value is one) because napi's `Vec<u8>` marshals as a
/// JS Array of numbers: an 8.3M-element array per 1080p frame crosses the
/// boundary twice, and `Buffer.concat` on the JS side is the only thing that
/// ever made that affordable.
///
/// Returns the composited RGBA frame as a Buffer of exactly
/// `output_width * output_height * 4` bytes.
#[napi]
pub fn composite_frame_gpu(
    layers_json: String,
    frame_buffers: Buffer,
    output_width: u32,
    output_height: u32,
) -> Result<Buffer> {
    let descriptors: Vec<GpuLayerDesc> = serde_json_parse(&layers_json)?;
    validate_canvas(output_width, output_height)?;
    let frame_buffers: &[u8] = frame_buffers.as_ref();

    // Split frame_buffers into per-layer slices. The bytes are copied out of
    // the JS-owned buffer per layer, so nothing holds a view of JS memory
    // across the upload.
    let ranges = layer_byte_ranges(&descriptors, frame_buffers.len())?;
    let gpu_layers: Vec<GpuLayer> = descriptors
        .into_iter()
        .zip(ranges)
        .map(|(desc, range)| desc.into_gpu_layer(frame_buffers[range].to_vec()))
        .collect();

    // Try GPU path first, fall back to CPU
    match gpu::state_for_composite() {
        gpu::Composite::Ready(state) => state
            .pipeline
            .composite(&state.device, &state.queue, &gpu_layers, output_width, output_height)
            .map(Buffer::from)
            .map_err(|e| {
                // A frame that fails *and* a device that went away are the same
                // event seen from two sides: wgpu never completes a pending map
                // on a lost device, so the readback is what reports it. Saying
                // so is what keeps the caller from latching a permanent CPU
                // fallback over something the addon rebuilds on the next call.
                if gpu::is_lost() {
                    Error::new(
                        Status::GenericFailure,
                        gpu::device_lost_message(
                            &gpu::lost_reason().unwrap_or_else(|| e.clone()),
                        ),
                    )
                } else {
                    Error::new(Status::GenericFailure, format!("GPU composite: {e}"))
                }
            }),
        // CPU fallback — construct pixel-based composite without file loading
        gpu::Composite::Absent => cpu_composite_from_buffers(&gpu_layers, output_width, output_height)
            .map(Buffer::from),
        // A device that existed and was lost is not the same answer as one that
        // was never there, and the caller has to be able to tell them apart:
        // the marker is what `preview-compositor.ts` branches on to retry the
        // next frame instead of latching the preview onto the CPU compositor
        // for the rest of the session. The dead device has already been
        // dropped, so the retry is a real rebuild rather than a repeat.
        gpu::Composite::Lost(reason) => Err(Error::new(
            Status::GenericFailure,
            gpu::device_lost_message(&reason),
        )),
    }
}

/// One layer of the preview composite as the JS call site describes it.
///
/// Field names, requiredness and defaults are the cross-language contract with
/// `src/main/media/preview-compositor.ts` (GpuLayerDesc): `width`, `height`,
/// `x`, `y` and `opacity` are always written, the transform/wipe fields are
/// written but defaulted here so an older caller deserializes.
#[derive(Debug, serde::Deserialize)]
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

fn default_scale() -> f32 {
    1.0
}

fn default_progress() -> f32 {
    1.0
}

impl GpuLayerDesc {
    /// The GPU-side layer this describes, carrying its slice of the frame
    /// buffer. Split out from the napi entry point so the descriptor → layer
    /// mapping is testable without a device.
    fn into_gpu_layer(self, rgba_data: Vec<u8>) -> GpuLayer {
        GpuLayer {
            rgba_data,
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
            opacity: self.opacity,
            rotation_deg: self.rotation_deg,
            scale_x: self.scale_x,
            scale_y: self.scale_y,
            anchor_x: self.anchor_x,
            anchor_y: self.anchor_y,
            blend_mode: self.blend_mode,
            wipe_mode: self.wipe_mode,
            wipe_progress: self.wipe_progress,
            wipe_softness: self.wipe_softness,
        }
    }
}

/// Byte range of every layer inside the concatenated frame buffer, in order.
///
/// Each layer owns exactly `width * height * 4` bytes, so this is the whole of
/// the JS↔Rust buffer contract: the ranges are contiguous, in layer order, and
/// must fit inside what the caller actually passed. Trailing bytes are
/// ignored (the caller may over-allocate); a short buffer is an InvalidArg,
/// because a silently truncated layer is a corrupt texture upload.
fn layer_byte_ranges(
    descriptors: &[GpuLayerDesc],
    frame_buffers_len: usize,
) -> Result<Vec<Range<usize>>> {
    let mut ranges = Vec::with_capacity(descriptors.len());
    let mut offset: usize = 0;

    for desc in descriptors {
        let layer_size = rgba_len(desc.width, desc.height)?;
        let remaining = frame_buffers_len - offset;
        if layer_size > remaining {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Buffer too small: need {} bytes for layer ({}x{}), have {} remaining",
                    layer_size, desc.width, desc.height, remaining
                ),
            ));
        }
        ranges.push(offset..offset + layer_size);
        offset += layer_size;
    }

    Ok(ranges)
}

/// Bytes one `width` × `height` RGBA layer or canvas occupies.
///
/// u64 math on purpose: `width * height * 4` in u32 wraps at 65536×65536, and
/// a wrapped length is a *plausible* length — it would allocate a
/// wrongly-sized frame that the renderer then discards as mis-sized, instead
/// of reporting the bad descriptor.
fn rgba_len(width: u32, height: u32) -> Result<usize> {
    let bytes = u64::from(width) * u64::from(height) * 4;
    usize::try_from(bytes).map_err(|_| {
        Error::new(
            Status::InvalidArg,
            format!("RGBA size {width}x{height} exceeds addressable memory"),
        )
    })
}

/// Reject an output canvas the GPU cannot allocate.
///
/// wgpu answers a zero-sized or over-limit `create_texture` with an internal
/// validation *panic*, and a panic unwinding out of a napi callback aborts the
/// host process (measured: exit code 0xC0000409) instead of raising a
/// catchable error — so this has to be refused before the render target is
/// created. The limit is `wgpu::Limits::default()`, which is exactly what
/// `gpu.rs` asks the device for.
fn validate_canvas(width: u32, height: u32) -> Result<()> {
    let max = wgpu::Limits::default().max_texture_dimension_2d;
    if width == 0 || height == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Output canvas {width}x{height} is empty"),
        ));
    }
    if width > max || height > max {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Output canvas {width}x{height} exceeds the {max}px GPU texture limit"),
        ));
    }
    Ok(())
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

/// Bilinear sample of a layer's straight RGBA at normalized `(u, v)`.
///
/// The pipeline's sampler is `FilterMode::Linear` on both axes (`pipeline.rs`),
/// so a rotated or scaled quad is resampled bilinearly on the GPU; a
/// nearest-neighbour read here would put a second, subtler disagreement exactly
/// where the transform is. Clamp-to-edge matches the sampler address mode.
fn sample_layer_bilinear(layer: &GpuLayer, u: f32, v: f32) -> [f32; 4] {
    let fx = u * layer.width as f32 - 0.5;
    let fy = v * layer.height as f32 - 0.5;
    let x0 = fx.floor();
    let y0 = fy.floor();
    let tx = fx - x0;
    let ty = fy - y0;
    let x0 = x0 as i32;
    let y0 = y0 as i32;

    let mut out = [0.0f32; 4];
    for (dx, wx) in [(0, 1.0 - tx), (1, tx)] {
        for (dy, wy) in [(0, 1.0 - ty), (1, ty)] {
            let weight = wx * wy;
            if weight <= 0.0 {
                continue;
            }
            let sx = (x0 + dx).clamp(0, layer.width as i32 - 1);
            let sy = (y0 + dy).clamp(0, layer.height as i32 - 1);
            let offset = ((sy as u32 * layer.width + sx as u32) * 4) as usize;
            if offset + 3 >= layer.rgba_data.len() {
                continue;
            }
            for ch in 0..4 {
                out[ch] += weight * (layer.rgba_data[offset + ch] as f32 / 255.0);
            }
        }
    }
    out
}

/// CPU fallback compositor that works with pre-decoded RGBA buffers.
///
/// Mirrors the GPU path rather than approximating it. For every output pixel it
/// inverts the *same* `geometry::affine_transform` the shader's vertex stage
/// receives, so rotation, scale and anchor reach the fallback exactly as they
/// reach the GPU, and applies the same W3C blend against the accumulated
/// backdrop starting from a transparent canvas.
///
/// Inverting the shared matrix per output pixel — rather than blitting an
/// axis-aligned rect — is what makes the transform apply at all, and this is not
/// a corner case: `--mcp-server` mode never calls `gpuInit()`, so in MCP mode
/// this function is the only compositor there is.
fn cpu_composite_from_buffers(
    layers: &[GpuLayer],
    output_width: u32,
    output_height: u32,
) -> Result<Vec<u8>> {
    let mut buffer = vec![0u8; rgba_len(output_width, output_height)?];

    for layer in layers {
        if layer.opacity <= 0.0 || layer.rgba_data.is_empty() || layer.width == 0 || layer.height == 0 {
            continue;
        }

        // The forward matrix the GPU uploads as the quad's vertex transform.
        let m = geometry::affine_transform(
            layer.x,
            layer.y,
            layer.width as f32,
            layer.height as f32,
            layer.rotation_deg,
            layer.scale_x,
            layer.scale_y,
            layer.anchor_x,
            layer.anchor_y,
        );
        let (a, b, tx) = (m.0[0][0], m.0[0][1], m.0[0][2]);
        let (c, d, ty) = (m.0[1][0], m.0[1][1], m.0[1][2]);
        // A singular transform has no area, so the GPU rasterizes nothing for
        // it. There is nothing to invert, and dividing by the determinant would
        // only produce NaNs the coverage test below happens to discard.
        let det = a * d - b * c;
        if !det.is_finite() || det == 0.0 {
            continue;
        }
        let inv_det = 1.0 / det;

        // Only the parallelogram's four corners can reach the canvas, so iterate
        // its bounding box rather than the whole frame: the fallback is on the
        // MCP composite path, where a full-canvas sweep per layer would turn a
        // per-layer blit into (canvas pixels x layers) work.
        let mut bounds = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
        for (corner_x, corner_y) in [
            (0.0, 0.0),
            (layer.width as f32, 0.0),
            (layer.width as f32, layer.height as f32),
            (0.0, layer.height as f32),
        ] {
            let world_x = a * corner_x + b * corner_y + tx;
            let world_y = c * corner_x + d * corner_y + ty;
            bounds[0] = bounds[0].min(world_x);
            bounds[1] = bounds[1].min(world_y);
            bounds[2] = bounds[2].max(world_x);
            bounds[3] = bounds[3].max(world_y);
        }
        if !bounds.iter().all(|edge| edge.is_finite()) {
            continue;
        }
        // A pixel centre sits at `index + 0.5`; one can only be covered inside
        // the box, and the exact half-open decision belongs to the uv test below.
        let first_x = (bounds[0] - 0.5).floor().max(0.0) as u32;
        let first_y = (bounds[1] - 0.5).floor().max(0.0) as u32;
        let past_x = ((bounds[2] - 0.5).ceil().max(0.0) as u32).min(output_width);
        let past_y = ((bounds[3] - 0.5).ceil().max(0.0) as u32).min(output_height);

        for dst_y in first_y..past_y {
            for dst_x in first_x..past_x {
                // The GPU has no MSAA, so it shades exactly the pixels whose
                // centre falls inside the quad, and interpolates the layer uv at
                // that same centre. Mirror both.
                let px = dst_x as f32 + 0.5 - tx;
                let py = dst_y as f32 + 0.5 - ty;
                let local_x = (d * px - b * py) * inv_det;
                let local_y = (a * py - c * px) * inv_det;
                // local runs 0..width / 0..height across the quad, which is
                // precisely the uv the shader interpolates. The range is
                // half-open because a rasterizer's top-left fill rule shades
                // the left/top edge and leaves the right/bottom one to the
                // next pixel: a quad whose far edge lands exactly on a pixel
                // centre covers 4 pixels, not 5.
                let u = local_x / layer.width as f32;
                let v = local_y / layer.height as f32;
                if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
                    continue;
                }

                let cs = sample_layer_bilinear(layer, u, v);
                let mask = wipe_mask_cpu(layer.wipe_mode, layer.wipe_progress, layer.wipe_softness, u, v);
                let alpha_s = cs[3] * layer.opacity * mask;
                if alpha_s <= 0.0 {
                    continue;
                }

                let dst_offset = ((dst_y * output_width + dst_x) * 4) as usize;
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
                    let b_channel = blend_channel_cpu(cb[ch], cs[ch], layer.blend_mode);
                    let co = alpha_s * (1.0 - alpha_b) * cs[ch]
                        + alpha_s * alpha_b * b_channel
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

// ─── Tests ───────────────────────────────────────────────────────────────────
//
// Everything here is device-free on purpose: `cargo test` is a CI gate on
// machines with no GPU, so the napi/geometry/buffer-split/compositing math is
// covered unconditionally and the two tests that need a real adapter are
// `#[ignore]`d (`cargo test -- --ignored`).

#[cfg(test)]
mod tests {
    use super::*;

    /// A descriptor with an identity transform, so a test only has to name
    /// the field it is actually about.
    fn desc(width: u32, height: u32) -> GpuLayerDesc {
        GpuLayerDesc {
            width,
            height,
            x: 0.0,
            y: 0.0,
            opacity: 1.0,
            rotation_deg: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            blend_mode: 0,
            wipe_mode: 0,
            wipe_progress: 1.0,
            wipe_softness: 0.0,
        }
    }

    /// A solid `width`×`height` RGBA layer.
    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        rgba.iter().copied().cycle().take((width * height * 4) as usize).collect()
    }

    fn pixel(frame: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let start = ((y * width + x) * 4) as usize;
        [frame[start], frame[start + 1], frame[start + 2], frame[start + 3]]
    }

    /// Blends are float math, so the expected value is a literal.
    fn near(got: f32, want: f32) -> bool {
        (got - want).abs() < 1e-5
    }

    // ── The JS↔Rust buffer contract ───────────────────────────────────────────

    #[test]
    fn layer_ranges_are_contiguous_and_in_layer_order() {
        let descriptors = [desc(2, 1), desc(1, 2), desc(3, 1)];
        let ranges = layer_byte_ranges(&descriptors, 2 * 1 * 4 + 1 * 2 * 4 + 3 * 1 * 4).unwrap();

        assert_eq!(ranges, vec![0..8, 8..16, 16..28]);
    }

    #[test]
    fn a_short_frame_buffer_is_rejected_with_the_layer_size() {
        let descriptors = [desc(2, 1), desc(2, 1)];
        let err = layer_byte_ranges(&descriptors, 12).unwrap_err();

        assert_eq!(err.status, Status::InvalidArg);
        let message = err.reason.to_string();
        assert!(message.contains("need 8 bytes for layer (2x1)"), "{message}");
        assert!(message.contains("have 4 remaining"), "{message}");
    }

    #[test]
    fn trailing_bytes_past_the_last_layer_are_ignored() {
        // The caller over-allocates (Buffer.concat of a rounded-up total); the
        // split must not mistake the tail for a layer.
        let ranges = layer_byte_ranges(&[desc(1, 1)], 4 + 4096).unwrap();
        assert_eq!(ranges, vec![0..4]);
    }

    #[test]
    fn a_zero_sized_layer_owns_no_bytes() {
        let ranges = layer_byte_ranges(&[desc(0, 8), desc(1, 1)], 4).unwrap();
        assert_eq!(ranges, vec![0..0, 0..4]);
    }

    #[test]
    fn rgba_len_does_not_wrap_a_size_that_overflows_u32() {
        // 65536 * 65536 * 4 == 2^34. In u32 this wraps to 0, which would report
        // an empty layer and let the caller read the next layer's pixels.
        assert_eq!(rgba_len(65_536, 65_536).unwrap(), 1usize << 34);
        // The canvas size PreviewCanvas actually requires for 1080p.
        assert_eq!(rgba_len(1920, 1080).unwrap(), 1920 * 1080 * 4);
    }

    #[test]
    fn descriptor_defaults_match_the_js_call_site() {
        // preview-compositor.ts writes every field; the defaults are what an
        // older/leaner caller gets, and they must be an identity transform on a
        // transparent-to-nothing layer rather than a zero scale.
        let parsed: Vec<GpuLayerDesc> =
            serde_json_parse(r#"[{"width":4,"height":2,"x":1,"y":2,"opacity":0.5}]"#).unwrap();

        assert_eq!(parsed.len(), 1);
        let layer = parsed.into_iter().next().unwrap().into_gpu_layer(Vec::new());
        assert_eq!((layer.rotation_deg, layer.scale_x, layer.scale_y), (0.0, 1.0, 1.0));
        assert_eq!((layer.anchor_x, layer.anchor_y), (0.0, 0.0));
        assert_eq!((layer.blend_mode, layer.wipe_mode, layer.wipe_progress), (0, 0, 1.0));
    }

    #[test]
    fn a_malformed_layer_array_is_an_invalid_arg() {
        let err = serde_json_parse::<Vec<GpuLayerDesc>>("[{\"width\":4}]").unwrap_err();
        assert_eq!(err.status, Status::InvalidArg);
    }

    /// wgpu answers an unallocatable render target with a panic, and a panic
    /// leaving a napi callback aborts the host process rather than throwing --
    /// so the canvas is refused as data instead.
    #[test]
    fn an_unallocatable_canvas_is_an_invalid_arg() {
        let max = wgpu::Limits::default().max_texture_dimension_2d;
        for (width, height) in [(0, 0), (0, 8), (8, 0), (max + 1, 8), (8, max + 1)] {
            let err = validate_canvas(width, height).unwrap_err();
            assert_eq!(err.status, Status::InvalidArg, "{width}x{height}");
        }
        // 1080p and 8K both have to keep working.
        for (width, height) in [(1920, 1080), (7680, 4320), (max, max)] {
            assert!(validate_canvas(width, height).is_ok(), "{width}x{height}");
        }
    }

    /// The round trip the napi return value makes: `Vec<u8>` → `Buffer` →
    /// JS → `webContents.send('preview:frame')`. `Buffer` owns the vector, so
    /// the wrap is free and byte-exact, and its length is the only thing the
    /// renderer checks before painting.
    #[test]
    fn a_buffer_round_trips_the_composited_frame_byte_exactly() {
        let frame = cpu_composite_from_buffers(
            &[desc(2, 2).into_gpu_layer(solid(2, 2, [10, 20, 30, 255]))],
            4,
            4,
        )
        .unwrap();
        let buffer: Buffer = Buffer::from(frame.clone());

        assert_eq!(buffer.len(), 4 * 4 * 4);
        assert_eq!(&*buffer, &frame[..]);
    }

    // ── CPU compositor (the no-gpuInit fallback) ─────────────────────────────

    #[test]
    fn an_empty_composite_is_a_transparent_canvas() {
        let frame = cpu_composite_from_buffers(&[], 3, 2).unwrap();
        assert_eq!(frame, vec![0u8; 3 * 2 * 4]);
    }

    #[test]
    fn one_opaque_layer_copies_its_pixels_at_its_position() {
        let layer = desc(2, 2).into_gpu_layer(solid(2, 2, [1, 2, 3, 255]));
        let mut placed = layer;
        (placed.x, placed.y) = (1.0, 1.0);

        let frame = cpu_composite_from_buffers(&[placed], 4, 4).unwrap();

        assert_eq!(pixel(&frame, 4, 0, 0), [0, 0, 0, 0], "outside the layer");
        assert_eq!(pixel(&frame, 4, 1, 1), [1, 2, 3, 255]);
        assert_eq!(pixel(&frame, 4, 2, 2), [1, 2, 3, 255]);
        assert_eq!(pixel(&frame, 4, 3, 3), [0, 0, 0, 0], "outside the layer");
    }

    #[test]
    fn a_layer_is_clipped_to_the_canvas_on_every_side() {
        let mut layer = desc(2, 2).into_gpu_layer(solid(2, 2, [9, 9, 9, 255]));
        (layer.x, layer.y) = (-1.0, -1.0);

        let frame = cpu_composite_from_buffers(&[layer], 4, 4).unwrap();

        // Only the layer's (1,1) pixel lands inside the canvas, at (0,0).
        assert_eq!(pixel(&frame, 4, 0, 0), [9, 9, 9, 255]);
        assert_eq!(pixel(&frame, 4, 1, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&frame, 4, 0, 1), [0, 0, 0, 0]);
    }

    #[test]
    fn a_layer_entirely_off_canvas_contributes_nothing() {
        let mut layer = desc(2, 2).into_gpu_layer(solid(2, 2, [9, 9, 9, 255]));
        (layer.x, layer.y) = (8.0, 8.0);

        assert_eq!(cpu_composite_from_buffers(&[layer], 4, 4).unwrap(), vec![0u8; 4 * 4 * 4]);
    }

    #[test]
    fn a_zero_opacity_or_empty_layer_is_skipped() {
        let mut faded = desc(1, 1).into_gpu_layer(solid(1, 1, [7, 7, 7, 255]));
        faded.opacity = 0.0;

        let frame = cpu_composite_from_buffers(
            &[faded, desc(1, 1).into_gpu_layer(Vec::new())],
            2,
            1,
        )
        .unwrap();

        assert_eq!(frame, vec![0u8; 2 * 1 * 4]);
    }

    #[test]
    fn a_translucent_layer_over_nothing_keeps_its_colour_and_scales_its_alpha() {
        // Over a transparent backdrop the composite is the source colour
        // unpremultiplied by its own alpha -- i.e. a straight copy, with the
        // alpha channel left alone.
        let frame = cpu_composite_from_buffers(
            &[desc(1, 1).into_gpu_layer(vec![200, 100, 50, 128])],
            1,
            1,
        )
        .unwrap();

        assert_eq!(frame, vec![200, 100, 50, 128]);
    }

    #[test]
    fn a_normal_layer_over_an_opaque_backdrop_replaces_it_by_its_own_alpha() {
        let bottom = desc(1, 1).into_gpu_layer(solid(1, 1, [10, 10, 10, 255]));
        let mut top = desc(1, 1).into_gpu_layer(vec![250, 0, 0, 128]);
        top.x = 1.0;

        let frame = cpu_composite_from_buffers(&[bottom, top], 2, 1).unwrap();

        assert_eq!(pixel(&frame, 2, 0, 0), [10, 10, 10, 255], "backdrop untouched");
        assert_eq!(pixel(&frame, 2, 1, 0), [250, 0, 0, 128]);
    }

    #[test]
    fn a_multiply_layer_darkens_the_backdrop_it_blends_with() {
        // W3C multiply with an opaque backdrop: result = B(Cb, Cs).
        let bottom = desc(1, 1).into_gpu_layer(solid(1, 1, [200, 200, 200, 255]));
        let mut top = desc(1, 1).into_gpu_layer(solid(1, 1, [128, 255, 0, 255]));
        top.blend_mode = 1;

        let frame = cpu_composite_from_buffers(&[bottom, top], 1, 1).unwrap();

        let got = pixel(&frame, 1, 0, 0);
        let want = [
            (200.0f32 / 255.0 * 128.0 / 255.0 * 255.0).round() as u8,
            200,
            0,
            255,
        ];
        assert_eq!(got, want);
    }

    #[test]
    fn a_wiped_layer_is_fully_masked_where_the_wipe_has_not_reached() {
        // Reveal from the left, half way, with a near-zero softness: the left
        // column is opaque and the right column is still invisible.
        let mut layer = desc(2, 1).into_gpu_layer(solid(2, 1, [5, 5, 5, 255]));
        layer.wipe_mode = 1;
        layer.wipe_progress = 0.5;
        layer.wipe_softness = 0.001;

        let frame = cpu_composite_from_buffers(&[layer], 2, 1).unwrap();

        assert_eq!(pixel(&frame, 2, 0, 0), [5, 5, 5, 255]);
        assert_eq!(pixel(&frame, 2, 1, 0), [0, 0, 0, 0]);
    }

    /// An RGBA layer that encodes each texel's own index in its red channel, so
    /// a test can name *which* source pixel landed where instead of only proving
    /// that something was drawn.
    fn located(width: u32, height: u32) -> Vec<u8> {
        let mut data = vec![0u8; (width * height * 4) as usize];
        for row in 0..height {
            for col in 0..width {
                let offset = ((row * width + col) * 4) as usize;
                data[offset] = located_id(col, row, width);
                data[offset + 3] = 255;
            }
        }
        data
    }

    /// The red channel `located` writes for a texel.
    fn located_id(col: u32, row: u32, width: u32) -> u8 {
        (row * width + col + 1) as u8
    }

    /// The fallback must apply scale, not just translation. This is the whole
    /// point: `--mcp-server` mode never calls `gpuInit()`, so here the fallback
    /// is the only compositor, and a dropped transform ships a different frame
    /// from the one the preview showed.
    #[test]
    fn the_cpu_fallback_applies_scale() {
        let mut layer = desc(2, 2).into_gpu_layer(solid(2, 2, [7, 7, 7, 255]));
        (layer.scale_x, layer.scale_y) = (2.0, 2.0);

        let frame = cpu_composite_from_buffers(&[layer], 8, 8).unwrap();

        // The quad spans local 0..2 scaled by 2, i.e. canvas 0..4, so its
        // far corner is covered and the next pixel out is not. Translation-only
        // would have stopped at x=1.
        assert_eq!(pixel(&frame, 8, 3, 3), [7, 7, 7, 255], "scaled quad covers 4x4");
        assert_eq!(pixel(&frame, 8, 0, 0), [7, 7, 7, 255]);
        assert_eq!(pixel(&frame, 8, 4, 4), [0, 0, 0, 0], "and no further");
    }

    /// Rotation, proved by *which* texel moved where: a 90-degree turn about
    /// `(4, 0)` sends world = (4 - local_y, local_x), so the layer's top-left
    /// texel lands at canvas (3, 0) and its bottom-left at (2, 0). An unrotated
    /// blit would have put them the other way up.
    #[test]
    fn the_cpu_fallback_applies_rotation() {
        let mut layer = desc(2, 2).into_gpu_layer(located(2, 2));
        (layer.x, layer.y) = (4.0, 0.0);
        layer.rotation_deg = 90.0;

        let frame = cpu_composite_from_buffers(&[layer], 8, 8).unwrap();

        assert_eq!(pixel(&frame, 8, 3, 0)[0], located_id(0, 0, 2), "top-left texel");
        assert_eq!(pixel(&frame, 8, 2, 0)[0], located_id(0, 1, 2), "bottom-left texel");
        assert_eq!(pixel(&frame, 8, 3, 1)[0], located_id(1, 0, 2), "top-right texel");
        assert_eq!(pixel(&frame, 8, 0, 0), [0, 0, 0, 0], "nothing left of the turn");
    }

    /// The anchor is the pivot, so a rotated layer spins about it and a zero
    /// anchor spins about the canvas origin instead. A 3x3 layer at (4, 4) turned
    /// 90 degrees about (1.5, 1.5) lands its centre texel exactly on its anchor
    /// point, (5.5, 5.5) -> pixel (5, 5); with a zero anchor that same texel
    /// would sit at (2, 5). Half-integer so the pivot is a texel *centre* and
    /// the expectation is exact rather than a corner.
    #[test]
    fn the_cpu_fallback_applies_anchor_as_the_pivot() {
        let mut layer = desc(3, 3).into_gpu_layer(located(3, 3));
        (layer.x, layer.y) = (4.0, 4.0);
        layer.rotation_deg = 90.0;
        (layer.anchor_x, layer.anchor_y) = (1.5, 1.5);

        let frame = cpu_composite_from_buffers(&[layer], 12, 12).unwrap();

        assert_eq!(pixel(&frame, 12, 5, 5)[0], located_id(1, 1, 3), "centred on the anchor");
        assert_eq!(pixel(&frame, 12, 2, 5), [0, 0, 0, 0], "not on the origin-pivot position");
    }

    /// A zero-area transform (scale 0, or a non-finite descriptor) cannot be
    /// inverted, and the GPU rasterizes nothing for it either.
    #[test]
    fn the_cpu_fallback_skips_a_transform_with_no_area() {
        let mut collapsed = desc(2, 2).into_gpu_layer(solid(2, 2, [4, 4, 4, 255]));
        collapsed.scale_x = 0.0;
        let mut broken = desc(2, 2).into_gpu_layer(solid(2, 2, [4, 4, 4, 255]));
        broken.rotation_deg = f32::NAN;

        let frame = cpu_composite_from_buffers(&[collapsed, broken], 4, 4).unwrap();

        assert_eq!(frame, vec![0u8; 4 * 4 * 4]);
    }

    // ── Blend channels ───────────────────────────────────────────────────────

    #[test]
    fn an_unknown_blend_index_composites_as_normal() {
        // Index drift between blend-mode.ts and the shader must degrade to
        // source-over, not to an arbitrary mode.
        for mode in [12, 255, u32::MAX] {
            assert_eq!(blend_channel_cpu(0.25, 0.75, mode), 0.75);
        }
    }

    /// Black over black is black in every mode, normal included: a blend mode
    /// can never invent light that neither side has.
    #[test]
    fn blending_black_onto_black_stays_black() {
        for mode in 0..=11 {
            assert!(near(blend_channel_cpu(0.0, 0.0, mode), 0.0), "mode {mode}");
        }
    }

    /// The separable modes only have to agree on which neutral they treat as
    /// "leave the other channel alone" -- that is what makes `multiply` with a
    /// white source and `screen` with a black source no-ops.
    #[test]
    fn each_mode_has_its_documented_neutral() {
        for cs in [0.0, 0.25, 0.5, 0.75, 1.0] {
            assert!(near(blend_channel_cpu(cs, 1.0, 1), cs), "multiply by white: {cs}");
            assert!(near(blend_channel_cpu(0.0, cs, 2), cs), "screen over black: {cs}");
            assert!(near(blend_channel_cpu(cs, 1.0, 4), cs), "darken by white: {cs}");
            assert!(near(blend_channel_cpu(0.0, cs, 5), cs), "lighten over black: {cs}");
        }
    }

    /// Overlay and hard-light pick their branch from different channels --
    /// overlay from the backdrop, hard-light from the source -- so each is the
    /// identity against mid grey on the channel it does *not* read.
    #[test]
    fn overlay_and_hard_light_are_identities_against_mid_grey() {
        for v in [0.0, 0.25, 0.5, 0.75, 1.0] {
            assert!(near(blend_channel_cpu(v, 0.5, 3), v), "overlay by mid grey: {v}");
            assert!(near(blend_channel_cpu(0.5, v, 3), v), "overlay onto mid grey: {v}");
            assert!(near(blend_channel_cpu(0.5, v, 8), v), "hard-light by mid grey: {v}");
        }
        // A hard-light source is a hard switch: black gives black, white gives
        // white, whatever the backdrop happens to be.
        for cb in [0.0, 0.25, 0.5, 0.75, 1.0] {
            assert!(near(blend_channel_cpu(cb, 0.0, 8), 0.0), "hard-light black source: {cb}");
            assert!(near(blend_channel_cpu(cb, 1.0, 8), 1.0), "hard-light white source: {cb}");
        }
    }

    #[test]
    fn blend_results_stay_inside_the_unit_range() {
        for mode in 0..=11 {
            for cb in [0.0, 0.01, 0.25, 0.5, 0.75, 0.99, 1.0] {
                for cs in [0.0, 0.01, 0.25, 0.5, 0.75, 0.99, 1.0] {
                    let blended = blend_channel_cpu(cb, cs, mode);
                    assert!(
                        (0.0..=1.0).contains(&blended),
                        "mode {mode}: blend({cb}, {cs}) = {blended}"
                    );
                }
            }
        }
    }

    #[test]
    fn multiply_screen_darken_and_lighten_match_the_w3c_definitions() {
        assert_eq!(blend_channel_cpu(0.5, 0.5, 1), 0.25); // multiply
        assert_eq!(blend_channel_cpu(0.5, 0.5, 2), 0.75); // screen
        assert_eq!(blend_channel_cpu(0.5, 0.5, 4), 0.5); // darken
        assert_eq!(blend_channel_cpu(0.5, 0.5, 5), 0.5); // lighten
        // The identity elements each mode has to honour.
        assert_eq!(blend_channel_cpu(0.4, 1.0, 1), 0.4);
        assert_eq!(blend_channel_cpu(0.4, 0.0, 2), 0.4);
        assert_eq!(blend_channel_cpu(0.4, 1.0, 4), 0.4);
        assert_eq!(blend_channel_cpu(0.4, 0.0, 5), 0.4);
    }

    #[test]
    fn overlay_is_hard_light_with_the_channels_swapped() {
        for cb in [0.0, 0.2, 0.5, 0.8, 1.0] {
            for cs in [0.0, 0.2, 0.5, 0.8, 1.0] {
                assert_eq!(
                    blend_channel_cpu(cb, cs, 3),
                    blend_channel_cpu(cs, cb, 8),
                    "overlay({cb}, {cs}) != hard_light({cs}, {cb})"
                );
            }
        }
    }

    #[test]
    fn color_dodge_and_burn_hit_their_extremes() {
        // Dodge: a black backdrop stays black, a white source saturates.
        assert_eq!(blend_channel_cpu(0.0, 0.5, 6), 0.0);
        assert_eq!(blend_channel_cpu(0.5, 1.0, 6), 1.0);
        assert_eq!(blend_channel_cpu(1.0, 0.5, 6), 1.0, "divides by zero, saturates");
        // Burn: a white backdrop stays white, a black source stays black.
        assert_eq!(blend_channel_cpu(1.0, 0.5, 7), 1.0);
        assert_eq!(blend_channel_cpu(0.5, 0.0, 7), 0.0);
        assert_eq!(blend_channel_cpu(0.0, 0.5, 7), 0.0);
    }

    #[test]
    fn difference_and_exclusion_match_their_definitions() {
        assert!(near(blend_channel_cpu(0.3, 0.7, 10), 0.4)); // |cb - cs|
        assert!(near(blend_channel_cpu(0.5, 0.5, 10), 0.0));
        assert!(near(blend_channel_cpu(0.25, 0.5, 11), 0.5)); // cb + cs - 2cb*cs
        assert!(near(blend_channel_cpu(1.0, 1.0, 11), 0.0));
    }

    /// Soft light's two branches have defining endpoints, and neither is "the
    /// backdrop passes through": a black source squares the backdrop, and a
    /// white source returns the W3C D(Cb) curve -- a polynomial below 0.25, a
    /// square root above it. Getting these backwards is the classic soft-light
    /// bug, so they are pinned exactly.
    #[test]
    fn soft_light_follows_its_two_defining_endpoints() {
        for cb in [0.0, 0.1, 0.25, 0.4, 0.5, 0.75, 1.0] {
            assert!(near(blend_channel_cpu(cb, 0.5, 9), cb), "neutral source: {cb}");
            assert!(near(blend_channel_cpu(cb, 0.0, 9), cb * cb), "black source: {cb}");
        }
        for cb in [0.0, 0.1, 0.25] {
            let d = ((16.0 * cb - 12.0) * cb + 4.0) * cb;
            assert!(near(blend_channel_cpu(cb, 1.0, 9), d), "white source: {cb}");
        }
        for cb in [0.26, 0.4, 0.75, 1.0] {
            assert!(near(blend_channel_cpu(cb, 1.0, 9), cb.sqrt()), "white source: {cb}");
        }
    }

    // ── Wipe masks ───────────────────────────────────────────────────────────

    #[test]
    fn no_wipe_and_an_unknown_mode_are_fully_visible() {
        for mode in [0, 5, 99] {
            for (u, v) in [(0.0, 0.0), (0.5, 0.5), (1.0, 1.0)] {
                assert_eq!(wipe_mask_cpu(mode, 0.3, 0.2, u, v), 1.0, "mode {mode}");
            }
        }
    }

    #[test]
    fn a_left_reveal_hides_the_side_it_has_not_reached() {
        let at = |u| wipe_mask_cpu(1, 0.5, 0.001, u, 0.5);
        assert_eq!(at(0.0), 1.0);
        assert_eq!(at(1.0), 0.0);
    }

    #[test]
    fn a_right_reveal_is_the_mirror_of_the_left_one() {
        for u in [0.0, 0.25, 0.5, 0.75, 1.0] {
            assert!((wipe_mask_cpu(2, 0.5, 0.001, u, 0.5) + wipe_mask_cpu(1, 0.5, 0.001, u, 0.5) - 1.0)
                .abs()
                < 1e-5);
        }
    }

    #[test]
    fn horizontal_wipes_ignore_v_and_vertical_wipes_ignore_u() {
        for mode in [1, 2] {
            for u in [0.0, 0.3, 0.9] {
                let a = wipe_mask_cpu(mode, 0.5, 0.2, u, 0.0);
                let b = wipe_mask_cpu(mode, 0.5, 0.2, u, 1.0);
                assert_eq!(a, b, "mode {mode} must depend on u only");
            }
        }
        for mode in [3, 4] {
            for v in [0.0, 0.3, 0.9] {
                let a = wipe_mask_cpu(mode, 0.5, 0.2, 0.0, v);
                let b = wipe_mask_cpu(mode, 0.5, 0.2, 1.0, v);
                assert_eq!(a, b, "mode {mode} must depend on v only");
            }
        }
    }

    #[test]
    fn a_fully_advanced_wipe_reveals_the_whole_layer_and_a_zero_one_nothing() {
        for mode in 1..=4 {
            let axis_first = wipe_mask_cpu(mode, 1.0, 0.001, 0.02, 0.02);
            let axis_last = wipe_mask_cpu(mode, 0.0, 0.001, 0.98, 0.98);
            assert!(axis_first > 0.99, "mode {mode} at progress 1");
            assert!(axis_last < 0.01, "mode {mode} at progress 0");
        }
    }

    #[test]
    fn softness_widens_the_transition() {
        // At the edge itself the mask is 0.5 for any softness; a wider band
        // moves the visible/invisible split away from the hard edge.
        assert!((wipe_mask_cpu(1, 0.5, 0.001, 0.5, 0.5) - 0.5).abs() < 1e-3);
        assert!((wipe_mask_cpu(1, 0.5, 0.25, 0.5, 0.5) - 0.5).abs() < 1e-3);
        assert!(wipe_mask_cpu(1, 0.5, 0.25, 0.7, 0.5) > wipe_mask_cpu(1, 0.5, 0.001, 0.7, 0.5));
    }

    // ── Device-dependent ─────────────────────────────────────────────────────

    /// Real adapter round trip: two layers, a transform, a blend, and the
    /// canvas-sized frame the renderer requires. Reaches `CompositorPipeline`
    /// directly rather than through the napi entry point, because a `cargo test`
    /// process has no napi host to receive a Buffer in; the Buffer wrapping
    /// itself is covered device-free above. Ignored by default because it needs
    /// a DX12/Vulkan device, and CI runs on machines that have neither.
    #[test]
    #[ignore = "needs a real GPU adapter; run: cargo test -- --ignored"]
    fn the_gpu_path_composites_two_layers_onto_a_canvas_sized_buffer() {
        let state = gpu::initialize_state().expect("a GPU adapter must be available for this test");

        let bottom = desc(4, 4).into_gpu_layer(solid(4, 4, [10, 20, 30, 255]));
        let mut top = desc(2, 2).into_gpu_layer(solid(2, 2, [200, 100, 50, 255]));
        (top.x, top.y) = (1.0, 1.0);

        let frame = state
            .pipeline
            .composite(&state.device, &state.queue, &[bottom, top], 8, 8)
            .expect("gpu composite");

        assert_eq!(frame.len(), 8 * 8 * 4, "the renderer only accepts canvas-sized frames");
        assert_eq!(pixel(&frame, 8, 0, 0), [10, 20, 30, 255], "bottom layer");
        assert_eq!(pixel(&frame, 8, 1, 1), [200, 100, 50, 255], "top layer");
    }

    /// The two compositors must agree byte for byte, for every blend mode.
    ///
    /// This is the preview/export parity check in its most direct form: the CPU
    /// fallback is the compositor whenever `gpuInit()` never ran (notably
    /// `--mcp-server` mode), and it is the arithmetic the FFmpeg export chain
    /// reproduces. The GPU used to sample and render through `Rgba8UnormSrgb`,
    /// so its blends ran in linear light while the CPU blended the sRGB bytes
    /// export works on: `screen` of 128/255 over 90/255 came out 148 on the GPU
    /// and 173 everywhere else. Both paths now blend in the same values.
    ///
    /// The two layers carry different values per channel, so a channel swap
    /// would fail this too rather than hide behind three equal greys.
    #[test]
    #[ignore = "needs a real GPU adapter; run: cargo test -- --ignored"]
    fn the_gpu_and_cpu_compositors_agree_byte_for_byte() {
        let state = gpu::initialize_state().expect("a GPU adapter must be available for this test");

        for mode in 0..=11u32 {
            // Two stacked layers, built twice because GpuLayer owns its pixels.
            let pair = || {
                let mut top = desc(2, 1).into_gpu_layer(solid(2, 1, [128, 200, 90, 255]));
                top.blend_mode = mode;
                [
                    desc(2, 1).into_gpu_layer(solid(2, 1, [90, 128, 200, 255])),
                    top,
                ]
            };

            let cpu = cpu_composite_from_buffers(&pair(), 2, 1).unwrap();
            let gpu = state
                .pipeline
                .composite(&state.device, &state.queue, &pair(), 2, 1)
                .expect("gpu composite");

            assert_eq!(gpu, cpu, "blend mode {mode}: gpu {gpu:?} vs cpu {cpu:?}");
        }
    }

    /// The readback has to survive being handed a *recycled* buffer, not just a
    /// fresh one: the pool means every frame after the first maps memory a
    /// previous frame already wrote, so a stale stride or a missed unmap would
    /// show up as a corrupted frame rather than as an error.
    #[test]
    #[ignore = "needs a real GPU adapter; run: cargo test -- --ignored"]
    fn consecutive_gpu_frames_over_a_recycled_readback_are_identical() {
        let state = gpu::initialize_state().expect("a GPU adapter must be available for this test");

        // 101 x 2 is deliberately not 256-byte aligned, so the de-padding path
        // has to be right for the bytes to match the single-buffer case.
        let layer = || desc(101, 2).into_gpu_layer(located(101, 2));
        let expected = cpu_composite_from_buffers(&[layer()], 128, 5).unwrap();

        for frame in 0..8 {
            let got = state
                .pipeline
                .composite(&state.device, &state.queue, &[layer()], 128, 5)
                .expect("gpu composite");
            assert_eq!(got, expected, "frame {frame} came back wrong from a recycled buffer");
        }
    }

    /// A canvas resize changes the padded stride, so the pool has to throw its
    /// buffers away rather than read a smaller frame out of a larger buffer's
    /// layout (which is a shifted frame, not a failure).
    #[test]
    #[ignore = "needs a real GPU adapter; run: cargo test -- --ignored"]
    fn a_canvas_resize_between_frames_recomposites_at_the_new_size() {
        let state = gpu::initialize_state().expect("a GPU adapter must be available for this test");

        let layer = || desc(4, 4).into_gpu_layer(solid(4, 4, [10, 20, 30, 255]));
        state.pipeline.composite(&state.device, &state.queue, &[layer()], 64, 64).unwrap();

        let resized = state
            .pipeline
            .composite(&state.device, &state.queue, &[layer()], 33, 17)
            .expect("gpu composite after a resize");

        assert_eq!(resized.len(), 33 * 17 * 4);
        assert_eq!(pixel(&resized, 33, 0, 0), [10, 20, 30, 255], "and still the layer's pixels");
    }
}

