//! GPU Render Pipeline — creates the wgpu pipeline for multi-layer compositing.
//!
//! Architecture:
//! - One render pass per frame, with one draw call per layer (painter's algorithm).
//! - Each layer uploads its RGBA texture, binds its transform uniform, and draws a quad.
//! - The output render target is read back as an RGBA buffer.

use crate::geometry;
use crate::gpu;
use bytemuck::{Pod, Zeroable};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use wgpu::util::DeviceExt;

/// The colour space every composited pixel is sampled, blended and stored in.
///
/// Deliberately `Rgba8Unorm` and *not* `Rgba8UnormSrgb`. An `Srgb` texture makes
/// the hardware decode to linear light on sample and re-encode on store, so the
/// blend math in `composite.wgsl` ran in linear light while the CPU fallback and
/// the entire FFmpeg export chain blended the sRGB bytes the user authored. That
/// is exactly the preview-vs-export disagreement this engine exists to prevent:
/// `screen` of 128/255 over 90/255 rendered 148 on the GPU and 173 everywhere
/// else. The export chain is the contract, so the GPU matches it.
const COMPOSITE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

// ─── Uniform struct (must match WGSL layout) ─────────────────────────────────

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct LayerUniforms {
    pub transform_row0: [f32; 4], // a, b, tx, _pad
    pub transform_row1: [f32; 4], // c, d, ty, _pad
    pub params: [f32; 4],         // opacity, canvas_width, canvas_height, _pad
    pub params2: [f32; 4],        // wipe_mode, wipe_progress, wipe_softness, _pad
}

// ─── GPU Layer descriptor (pre-parsed, with raw pixel data) ──────────────────

pub struct GpuLayer {
    pub rgba_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub x: f32,
    pub y: f32,
    pub opacity: f32,
    pub rotation_deg: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub anchor_x: f32,
    pub anchor_y: f32,
    /// Blend mode index (matches blend-mode.ts / composite.wgsl). 0 = normal.
    pub blend_mode: u32,
    /// Wipe transition: mode 0=none,1=left,2=right,3=up,4=down.
    pub wipe_mode: u32,
    pub wipe_progress: f32,
    pub wipe_softness: f32,
}

// ─── Readback ────────────────────────────────────────────────────────────────

/// How long the non-blocking readback spin runs before it escalates to one
/// real (still bounded) wait, in milliseconds.
///
/// A 1080p composite's fence normally lands within a couple of milliseconds, so
/// this budget covers the common case, and it is short enough that a wedged GPU
/// is reported rather than waited on. Measured uncontended, the value is not
/// sensitive: budgets of 0.25 ms, 1 ms and 4 ms were all within noise of each
/// other and of a plain `Maintain::Wait`. It is a *budget*, not a loop bound —
/// the spin cannot outlast it, and the escalation after it is a single
/// `Maintain::Wait`, so the wait is bounded twice over.
const READBACK_SPIN_BUDGET_MS: u64 = 4;

/// How many non-blocking polls run between yields.
///
/// Every pass is a `GetCompletedValue` plus three lock acquisitions. Yielding
/// periodically is what stops a spin from starving whatever else the Electron
/// main process is trying to do — this runs inside a synchronous `#[napi]`
/// call, on the thread that owns every window's timers and IPC. Also measured
/// as not sensitive (1, 4, 8, 32 and 128 all landed within noise), so this is
/// the smallest value that reliably hands the timeslice back.
const POLLS_BETWEEN_YIELDS: u32 = 8;

/// Where a `map_async` callback leaves its result.
///
/// A channel per frame is not the problem; the unconditional `recv()` after it
/// is. On a lost device wgpu never completes a pending map — the fence stops
/// advancing, so the submission is never triaged and the buffer is never
/// mapped (`Device::lose` says so outright: "Future calls to poll_devices will
/// continue to check the work queues until they are cleared") — so an untimed
/// receive parks the calling thread permanently. On the Electron main thread
/// that is a frozen application with no error and no way out. A slot can be
/// polled, so the readback can give up.
#[derive(Clone, Default)]
struct MapSlot(Arc<Mutex<Option<std::result::Result<(), wgpu::BufferAsyncError>>>>);

impl MapSlot {
    /// The callback's result, if it has fired. Taken rather than copied, so a
    /// callback that fires twice cannot resurrect a completed readback.
    fn take(&self) -> Option<std::result::Result<(), wgpu::BufferAsyncError>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// Whether the callback has fired, without consuming the result.
    fn landed(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    /// Record the callback's result. `None` when one is already recorded, so
    /// the first outcome wins.
    fn set(&self, result: std::result::Result<(), wgpu::BufferAsyncError>) {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(result);
        }
    }
}

/// Readback buffers, recycled across frames.
///
/// A fresh `MAP_READ` buffer per frame is a fresh driver allocation of the
/// whole padded canvas — 8.3 MB at 1080p — and its pages arrive cold, so the
/// `get_mapped_range` below faults in the whole thing from scratch every
/// frame. Recycling makes it one allocation per canvas shape for the life of
/// the pipeline.
///
/// Two is the depth the synchronous napi boundary allows: a buffer is handed
/// back before `composite` returns, so a frame never finds the list empty, and
/// a deeper ring would only matter once the entry point goes async and frame
/// N+1 can be submitted while frame N's map is still outstanding.
const READBACK_POOL_DEPTH: usize = 2;

struct ReadbackPool {
    /// Size the pooled buffers were built for. A canvas resize invalidates
    /// them: a buffer is only reusable at the exact byte count it was mapped
    /// and read back at.
    size: u64,
    free: Vec<wgpu::Buffer>,
}

impl ReadbackPool {
    fn new() -> Self {
        Self {
            size: 0,
            free: Vec::new(),
        }
    }

    /// A buffer of `size` bytes, reused when one is free.
    fn acquire(&mut self, device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        if self.size != size {
            // Drop the old ones rather than keeping them for a resize back:
            // they are megabytes of mapped-read memory each.
            self.free.clear();
            self.size = size;
        }
        if let Some(buffer) = self.free.pop() {
            return buffer;
        }
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("output-readback-buffer"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        })
    }

    /// Offer a buffer back once it has been unmapped.
    fn release(&mut self, buffer: wgpu::Buffer) {
        if buffer.size() == self.size && self.free.len() < READBACK_POOL_DEPTH {
            self.free.push(buffer);
        }
    }
}

/// Wait for a buffer map to land without ever parking the calling thread
/// forever, and without holding the device's locks for the whole wait.
///
/// This is a *robustness* change, not a throughput one. Measured on this
/// machine at 6 layers / 1080p over 400 frames, the spin and a plain
/// `Maintain::Wait` are within noise of each other (medians 9.20 vs
/// 9.09 ms/frame) — a D3D12 `Maintain::Wait` parks on
/// `SetEventOnCompletion`, so it never burned a core to begin with. What it did
/// do was make the outcome unbounded:
///
/// - `Maintain::Wait` blocks inside wgpu-core's `Device::maintain` while
///   holding the device's snatch lock, its fence read lock *and* the queue's
///   lifetime-tracker mutex, for up to `CLEANUP_WAIT_MS` = 60 s, and it returns
///   "not done" rather than failing when that expires. The old code then called
///   `rx.recv()`, which has no timeout at all — and on a lost device the
///   callback never fires, because `Device::lose` leaves the queue submissions
///   untriaged ("future calls to poll_devices will continue to check the work
///   queues until they are cleared") and the fence stops advancing. So the
///   failure mode of the old path was a permanently frozen Electron main
///   thread with no error, not a slow frame.
/// - `Maintain::Poll` takes the same three locks for one non-blocking pass and
///   releases them, so a poll can be abandoned and a genuine failure reported.
///
/// Hence the shape: a bounded spin, then one real (still bounded) wait, then an
/// error the caller can act on by dropping the device and rebuilding. The spin
/// is what makes the wait interruptible; the escalation is what keeps the
/// common case cheap.
fn await_mapped(device: &wgpu::Device, slot: &MapSlot) -> std::result::Result<(), String> {
    /// A landed callback is the answer. An absent one is either a device that
    /// went away -- in which case wgpu will *never* complete the map, so waiting
    /// longer is exactly wrong -- or a fence that has stopped advancing.
    fn settle(
        taken: Option<std::result::Result<(), wgpu::BufferAsyncError>>,
    ) -> std::result::Result<(), String> {
        match taken {
            Some(result) => result.map_err(|e| format!("Buffer map failed: {e}")),
            None if gpu::is_lost() => Err(gpu::device_lost_message(
                &gpu::lost_reason().unwrap_or_else(|| "lost during the readback".to_string()),
            )),
            None => Err(format!(
                "Readback did not complete within {READBACK_SPIN_BUDGET_MS}ms"
            )),
        }
    }

    let deadline = Instant::now() + Duration::from_millis(READBACK_SPIN_BUDGET_MS);
    let mut passes: u32 = 0;
    loop {
        if slot.landed() {
            return settle(slot.take());
        }
        // Checked before the escalation, not after it. On a lost device the
        // map callback is never invoked, so the only outcomes are "spin until
        // the budget expires" and "sit in a `Maintain::Wait` for up to 60 s
        // waiting for a fence that will never advance". Both are a frozen
        // Electron main thread; the first check here turns the second into an
        // immediate, reportable failure.
        if gpu::is_lost() || Instant::now() >= deadline {
            if !gpu::is_lost() {
                device.poll(wgpu::Maintain::Wait);
            }
            return settle(slot.take());
        }
        device.poll(wgpu::Maintain::Poll);
        passes = passes.wrapping_add(1);
        if passes % POLLS_BETWEEN_YIELDS == 0 {
            std::thread::yield_now();
        }
    }
}

/// Bytes a padded readback buffer of `height` rows occupies.
///
/// u64 math for the same reason `lib.rs::rgba_len` uses it: the buffer has to
/// be byte-exact, and a `u32` product that wrapped would be a plausible-looking
/// allocation rather than a reported error.
fn readback_buffer_size(padded_bytes_per_row: u32, height: u32) -> u64 {
    u64::from(padded_bytes_per_row) * u64::from(height)
}

/// Copy the canvas out of a mapped readback buffer, dropping the 256-byte row
/// padding wgpu requires of a texture→buffer copy.
///
/// Stride and width are separate arguments rather than one derived from the
/// other: the padding is the entire reason this exists, and a stride that
/// disagrees with what the buffer was written at is exactly the failure that
/// comes back as *shifted pixels* rather than as an error.
///
/// At 1080p there is no padding to drop — 1920 * 4 = 7680 = 30 * 256 — so the
/// per-row walk degenerates into 1080 `extend_from_slice` calls that between
/// them move exactly the bytes one `to_vec` would. Measured against the same
/// mapped buffer in one process, 12 interleaved batches of 30, the walk cost
/// 13-18% of the de-pad (95% CI on the paired delta excluded zero in all three
/// runs, roughly -0.37 ms at 1080p). A user does not see 18%: the same
/// measurement run end to end through `composite` could not resolve the change
/// at 1 or 6 layers, because the GPU readback wait varies by more than a
/// millisecond frame to frame. The saving is real, it is just small next to the
/// wait it sits behind.
///
/// The frame cannot go without a copy at all, which is why this is a stride
/// fast path and not a hand-off. The source is a driver-owned `MAP_READ` range
/// that is unmapped and recycled the instant `composite` returns, and the frame
/// itself is owned by JS — so a `Vec` the two sides can share has to be built,
/// and there is no sound way to build one without the copy.
///
/// What the fast path leaves behind is the 8.3 MB allocation, not the copy: in
/// the same harness, de-padding into an already-allocated `Vec` rather than a
/// fresh one runs at a third of the cost. That allocation is not removable
/// either, because the buffer's ownership leaves for JS and never comes back.
/// `measure_depad_against_the_row_loop_at_1080p` reproduces both numbers.
fn depad_rows(mapped: &[u8], width: u32, height: u32, stride: u32) -> Vec<u8> {
    let row_bytes = (width * 4) as usize;
    if stride as usize == row_bytes {
        // The stride *is* the row width, so the frame is the first
        // `row_bytes * height` bytes of the buffer and there is no gap to skip.
        #[cfg(test)]
        note_fast_path();
        return mapped[..row_bytes * height as usize].to_vec();
    }
    let mut out = Vec::with_capacity(row_bytes * height as usize);
    for row in 0..height as usize {
        let start = row * stride as usize;
        out.extend_from_slice(&mapped[start..start + row_bytes]);
    }
    out
}

/// How many frames have taken the aligned fast path, and what it is worth.
///
/// Test-only. The output of both branches is byte-identical, so "the fast path
/// returns the right bytes" and "the row loop returns the right bytes" are
/// indistinguishable from the outside; this counter is what lets a test assert
/// that the fast path *ran*, which is the claim being made. `#[cfg(test)]`, so
/// the shipped build carries neither the counter nor the call.
#[cfg(test)]
static FAST_PATH_HITS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[cfg(test)]
fn note_fast_path() {
    FAST_PATH_HITS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
fn fast_path_hits() -> u32 {
    FAST_PATH_HITS.load(std::sync::atomic::Ordering::Relaxed)
}

// ─── Pipeline state ──────────────────────────────────────────────────────────

pub struct CompositorPipeline {
    render_pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    readback: Mutex<ReadbackPool>,
}

impl CompositorPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader_source = include_str!("shaders/composite.wgsl");
        let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor-shader"),
            source: wgpu::ShaderSource::Wgsl(shader_source.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("layer-bind-group-layout"),
            entries: &[
                // Uniform buffer
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // Texture
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // Backdrop texture (accumulated composite, for blend modes)
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compositor-pipeline-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor-render-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module,
                entry_point: Some("vs_main"),
                buffers: &[], // no vertex buffers — positions from vertex_index
                compilation_options: Default::default(),
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader_module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: COMPOSITE_FORMAT,
                    // Compositing is done entirely in the fragment shader (it reads
                    // the backdrop and outputs the final pixel), so the fixed-function
                    // blender just replaces the destination within the layer quad.
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            multiview: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("layer-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        Self {
            render_pipeline,
            bind_group_layout,
            sampler,
            readback: Mutex::new(ReadbackPool::new()),
        }
    }

    /// The recycled readback buffers.
    ///
    /// A poisoned lock is recovered rather than propagated: the only thing lost
    /// is the free list, and `create_buffer` under it can panic on a wgpu
    /// validation failure, which would otherwise turn a reported validation
    /// error into a permanently broken compositor.
    fn readback(&self) -> MutexGuard<'_, ReadbackPool> {
        self.readback.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Composite multiple layers into an RGBA output buffer.
    /// Layers should be sorted by z_index (lowest first = painted first).
    pub fn composite(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layers: &[GpuLayer],
        output_width: u32,
        output_height: u32,
    ) -> Result<Vec<u8>, String> {
        // Create the output texture (render target)
        let output_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("output-texture"),
            size: wgpu::Extent3d {
                width: output_width,
                height: output_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COMPOSITE_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Backdrop texture — receives a copy of the accumulated composite before
        // each layer pass so the shader can sample it for blend modes.
        let backdrop_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("backdrop-texture"),
            size: wgpu::Extent3d {
                width: output_width,
                height: output_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COMPOSITE_FORMAT,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let backdrop_view = backdrop_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Create command encoder
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("compositor-encoder"),
        });

        // Clear pass — start from TRANSPARENT black so blend modes only take
        // effect against real layer content (W3C semantics; matches CPU fallback).
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("clear-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
        }

        // Draw each layer
        for layer in layers {
            if layer.opacity <= 0.0 || layer.rgba_data.is_empty() {
                continue;
            }

            // Upload layer texture
            let tex = device.create_texture_with_data(
                queue,
                &wgpu::TextureDescriptor {
                    label: Some("layer-texture"),
                    size: wgpu::Extent3d {
                        width: layer.width,
                        height: layer.height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: COMPOSITE_FORMAT,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                &layer.rgba_data,
            );
            let tex_view = tex.create_view(&wgpu::TextureViewDescriptor::default());

            // Compute affine transform
            let transform = geometry::affine_transform(
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

            let uniforms = LayerUniforms {
                transform_row0: [transform.0[0][0], transform.0[0][1], transform.0[0][2], 0.0],
                transform_row1: [transform.0[1][0], transform.0[1][1], transform.0[1][2], 0.0],
                params: [
                    layer.opacity,
                    output_width as f32,
                    output_height as f32,
                    layer.blend_mode as f32,
                ],
                params2: [
                    layer.wipe_mode as f32,
                    layer.wipe_progress,
                    layer.wipe_softness,
                    0.0,
                ],
            };

            let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("layer-uniform-buffer"),
                contents: bytemuck::cast_slice(&[uniforms]),
                usage: wgpu::BufferUsages::UNIFORM,
            });

            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("layer-bind-group"),
                layout: &self.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&tex_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(&backdrop_view),
                    },
                ],
            });

            // Snapshot the current composite into the backdrop texture so the
            // shader can read it (you cannot sample the render target you write).
            encoder.copy_texture_to_texture(
                wgpu::ImageCopyTexture {
                    texture: &output_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::ImageCopyTexture {
                    texture: &backdrop_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: output_width,
                    height: output_height,
                    depth_or_array_layers: 1,
                },
            );

            // Render pass for this layer (composites with the backdrop in-shader)
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("layer-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load, // preserve previous layers
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    ..Default::default()
                });

                pass.set_pipeline(&self.render_pipeline);
                pass.set_bind_group(0, &bind_group, &[]);
                pass.draw(0..6, 0..1); // 6 vertices = fullscreen quad
            }
        }

        // Copy output texture to a buffer for readback
        let bytes_per_row = output_width * 4;
        let padded_bytes_per_row = padded_bytes_per_row(bytes_per_row);
        let output_buffer_size = readback_buffer_size(padded_bytes_per_row, output_height);
        let output_buffer = self.readback().acquire(device, output_buffer_size);

        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &output_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &output_buffer,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(output_height),
                },
            },
            wgpu::Extent3d {
                width: output_width,
                height: output_height,
                depth_or_array_layers: 1,
            },
        );

        queue.submit(std::iter::once(encoder.finish()));

        // Read back the buffer
        let buffer_slice = output_buffer.slice(..);
        let slot = MapSlot::default();
        buffer_slice.map_async(wgpu::MapMode::Read, {
            let slot = slot.clone();
            move |result| slot.set(result)
        });
        await_mapped(device, &slot)?;

        // Copy data, removing row padding
        let frame = {
            let mapped = buffer_slice.get_mapped_range();
            depad_rows(&mapped, output_width, output_height, padded_bytes_per_row)
        };
        output_buffer.unmap();

        // Unmapped and idle again, so the next frame's readback reuses it
        // rather than allocating the whole padded canvas again.
        self.readback().release(output_buffer);

        Ok(frame)
    }
}

/// Row stride of a texture→buffer copy, padded to wgpu's 256-byte
/// `COPY_BYTES_PER_ROW_ALIGNMENT`. A stride that is not padded does not fail
/// loudly -- it validates the copy as reading past each row and returns
/// shifted pixels -- so the rule is worth pinning on its own.
fn padded_bytes_per_row(bytes_per_row: u32) -> u32 {
    (bytes_per_row + 255) & !255
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readback_rows_are_padded_to_256_bytes() {
        // Already aligned (1920 * 4 = 7680 = 30 * 256).
        assert_eq!(padded_bytes_per_row(1920 * 4), 7680);
        // One pixel: 4 bytes becomes a full 256-byte row.
        assert_eq!(padded_bytes_per_row(4), 256);
        assert_eq!(padded_bytes_per_row(100 * 4), 512);
        assert_eq!(padded_bytes_per_row(101 * 4), 512);
    }

    #[test]
    fn every_padded_stride_is_a_multiple_of_the_alignment() {
        for width in 1..=1024u32 {
            assert_eq!(padded_bytes_per_row(width * 4) % 256, 0, "width {width}");
        }
    }

    /// A readback buffer is reused only at the exact byte count it was mapped
    /// and read at, so the size has to be a plain product of the padded stride
    /// and the row count — never the unpadded row width, which would leave the
    /// last row of every non-aligned canvas past the end of the buffer.
    #[test]
    fn a_readback_buffer_is_the_padded_stride_times_the_rows() {
        let size = |width: u32, height: u32| {
            readback_buffer_size(padded_bytes_per_row(width * 4), height)
        };

        // 1080p happens to be aligned, so it cannot catch the difference...
        assert_eq!(size(1920, 1080), 7680 * 1080);
        // ...which is exactly why a non-aligned canvas is the one that has to.
        assert_eq!(size(101, 2), 512 * 2);
        assert_eq!(size(1, 1), 256);
        // Not the unpadded product: 101 * 4 = 404, not 512.
        assert!(size(101, 2) > 404 * 2);
    }

    /// The largest canvas wgpu's default limits allow, as a readback size. The
    /// old expression computed this product in `u32` and widened the result,
    /// which happens to fit at 8192 x 8192 (268435456) and would wrap into a
    /// plausible-looking short allocation the moment the limits were raised.
    /// Pinning the number keeps the buffer big enough either way.
    #[test]
    fn a_readback_buffer_is_padded_stride_times_rows_at_the_largest_canvas() {
        let max = wgpu::Limits::default().max_texture_dimension_2d;
        let stride = padded_bytes_per_row(max * 4);

        assert_eq!(
            readback_buffer_size(stride, max),
            u64::from(stride) * u64::from(max)
        );
    }

    /// A synthetic mapped readback buffer, one distinguishable value per pixel
    /// so a wrong stride shows up as a specific wrong row rather than as a
    /// plausible gradient. Under 256 pixels every value is also its own index,
    /// so a shift cannot hide behind a u8 wrap; wider canvases are only ever
    /// compared against a second de-pad of the same buffer, where the absolute
    /// value does not matter.
    fn padded_frame(width: u32, height: u32) -> (Vec<u8>, u32) {
        let stride = padded_bytes_per_row(width * 4);
        let mut mapped = vec![0u8; stride as usize * height as usize];
        for row in 0..height {
            for col in 0..width {
                let offset = row as usize * stride as usize + col as usize * 4;
                mapped[offset] = (row * width + col + 1) as u8;
                mapped[offset + 3] = 255;
            }
        }
        (mapped, stride)
    }

    #[test]
    fn de_padding_keeps_every_row_of_a_padded_readback() {
        let (mapped, stride) = padded_frame(101, 2);

        let frame = depad_rows(&mapped, 101, 2, stride);

        assert_eq!(frame.len(), 101 * 2 * 4, "the renderer only accepts canvas-sized frames");
        for (index, channel) in frame.chunks(4).enumerate() {
            assert_eq!(channel[0], index as u8 + 1, "pixel {index}");
            assert_eq!(channel[3], 255);
        }
    }

    #[test]
    fn de_padding_is_a_no_op_when_the_stride_is_the_row_width() {
        // An aligned canvas has no padding to remove, and the copy must still
        // be byte-exact rather than shifted by a row.
        let (mapped, stride) = padded_frame(1920, 2);
        assert_eq!(stride, 1920 * 4);

        let before = fast_path_hits();
        let frame = depad_rows(&mapped, 1920, 2, stride);

        assert_eq!(frame, mapped);
        // Equal bytes are what *both* branches produce, so this alone cannot
        // show the fast path ran — the depad walks the rows, so an aligned
        // canvas it skipped is a copy the frame no longer pays for.
        assert_eq!(
            fast_path_hits(),
            before + 1,
            "an aligned stride must not fall through to the per-row walk"
        );
    }

    /// The fast path is an optimisation, so the only property that makes it
    /// safe is that it is indistinguishable from the walk it replaces. Every
    /// canvas shape the readback can produce has to come back byte-for-byte
    /// the same from both, including the unaligned one where the two genuinely
    /// read different bytes out of the buffer.
    #[test]
    fn the_aligned_fast_path_agrees_with_the_row_walk_byte_for_byte() {
        // 1920 is 256-byte aligned (stride == row width), 1281 is not (512-byte
        // stride over a 5124-byte row), and 3 exercises a stride of several
        // whole rows for a canvas smaller than the alignment.
        for width in [1920u32, 1281, 3] {
            let (mapped, stride) = padded_frame(width, 2);
            let expected = row_loop_depad(&mapped, width, 2, stride);

            let fast = depad_rows(&mapped, width, 2, stride);

            assert_eq!(fast, expected, "{width} px wide");
            assert_eq!(fast.len(), width as usize * 2 * 4, "{width} px wide");
        }
    }

    /// A canvas whose row width is not a multiple of 256 is the case the fast
    /// path must *not* take, and the one that reaches the unaligned branch most
    /// often in practice: 1281x721 is what a window snapped to a non-integer
    /// device pixel ratio produces. The padding bytes are filled with the same
    /// value the rows use for alpha, so a frame that leaked the gap would be
    /// the right length and the wrong content.
    #[test]
    fn an_unaligned_row_width_still_drops_its_padding() {
        let (mapped, stride) = padded_frame(1281, 721);

        assert_ne!(stride, 1281 * 4, "1281 px is not a whole number of 256-byte rows");
        assert_eq!(stride, 5376, "5124 bytes of row padded up to 21 whole rows");
        assert_eq!(stride - 1281 * 4, 252, "so there really is a gap to drop");

        let before = fast_path_hits();
        let frame = depad_rows(&mapped, 1281, 721, stride);

        assert_eq!(frame, row_loop_depad(&mapped, 1281, 721, stride));
        assert_eq!(frame.len(), 1281 * 721 * 4);
        assert_eq!(fast_path_hits(), before, "the gap is real, so there is no fast path");
        for (index, channel) in frame.chunks(4).enumerate() {
            assert_eq!(channel[3], 255, "row padding leaked into pixel {index}");
        }
    }

    #[test]
    fn de_padding_drops_the_gap_itself_not_just_its_length() {
        // The padding bytes are garbage; if they leaked into the frame the
        // output would be the wrong length or contain the filler.
        let (mut mapped, stride) = padded_frame(3, 1);
        assert_eq!(stride, 256, "3 pixels is one 256-byte row");
        for byte in &mut mapped[12..] {
            *byte = 0xEE;
        }

        assert_eq!(depad_rows(&mapped, 3, 1, stride), vec![1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255]);
    }

    /// The map slot is what makes the wait abortable, so it has to behave like
    /// a one-shot latch: nothing to take before the callback fires, the
    /// outcome exactly once, and a second callback cannot replace it.
    #[test]
    fn the_map_slot_yields_its_result_exactly_once() {
        let slot = MapSlot::default();
        assert!(slot.take().is_none(), "nothing before the callback");

        slot.set(Ok(()));
        assert!(slot.take().is_some(), "the outcome after the callback");
        assert!(slot.take().is_none(), "and not again");

        slot.set(Err(wgpu::BufferAsyncError));
        slot.set(Ok(()));
        assert!(matches!(slot.take(), Some(Err(wgpu::BufferAsyncError))));
    }

    /// A slot handed to the `map_async` closure is a clone of the one the
    /// waiter polls, which is the only thing making the poll possible.
    #[test]
    fn a_map_slot_clone_shares_one_slot() {
        let slot = MapSlot::default();
        let callback_side = slot.clone();

        callback_side.set(Ok(()));

        assert!(slot.take().is_some());
    }

    /// The colour space is a parity contract, not a taste call. Export blends
    /// the sRGB bytes, so a GPU that decodes to linear light on sample would
    /// render a different preview from the file it delivers.
    #[test]
    fn the_compositor_does_not_blend_in_linear_light() {
        assert!(
            !COMPOSITE_FORMAT.is_srgb(),
            "{COMPOSITE_FORMAT:?} would blend in linear light"
        );
    }

    /// The uniform block is four WGSL `vec4<f32>`s. Both sides have to agree:
    /// a struct the shader cannot read as four vectors binds to garbage.
    #[test]
    fn the_layer_uniform_block_matches_the_wgsl_layout() {
        assert_eq!(std::mem::size_of::<LayerUniforms>(), 64);
        assert_eq!(std::mem::align_of::<LayerUniforms>(), 4);
        let uniforms = LayerUniforms {
            transform_row0: [1.0, 2.0, 3.0, 0.0],
            transform_row1: [4.0, 5.0, 6.0, 0.0],
            params: [7.0, 8.0, 9.0, 10.0],
            params2: [11.0, 12.0, 13.0, 0.0],
        };
        let bytes = bytemuck::bytes_of(&uniforms);
        // transform_row0, transform_row1, params, params2 at 16-byte strides.
        assert_eq!(&bytes[0..4], &1.0f32.to_ne_bytes());
        assert_eq!(&bytes[16..20], &4.0f32.to_ne_bytes());
        assert_eq!(&bytes[32..36], &7.0f32.to_ne_bytes());
        assert_eq!(&bytes[48..52], &11.0f32.to_ne_bytes());
        assert_eq!(&bytes[64 - 4..64], &0.0f32.to_ne_bytes());
    }

    // ── Measurement harness ──────────────────────────────────────────────────
    //
    // Scratch: run with `cargo test --release -- --ignored --nocapture
    // measure_`. Kept out of the default run because it needs a device and
    // takes ~a minute.

    /// The de-padding as it was written before the fast path, kept verbatim so
    /// the two forms can be run against the *same* mapped memory in one
    /// process. Interleaving them is what makes the delta trustworthy: absolute
    /// times on this machine drift ~25% between runs, so only the paired
    /// within-run difference carries information.
    fn row_loop_depad(mapped: &[u8], width: u32, height: u32, stride: u32) -> Vec<u8> {
        let row_bytes = (width * 4) as usize;
        let mut out = Vec::with_capacity(row_bytes * height as usize);
        for row in 0..height as usize {
            let start = row * stride as usize;
            out.extend_from_slice(&mapped[start..start + row_bytes]);
        }
        out
    }

    /// A mapped, GPU-written readback buffer of the same shape the pipeline
    /// composites into, so the copy is measured out of the memory it actually
    /// copies out of (driver-owned, host-visible) rather than out of a `Vec`.
    fn mapped_readback(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
    ) -> (wgpu::Buffer, u32) {
        let stride = padded_bytes_per_row(width * 4);
        let size = readback_buffer_size(stride, height);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("measure-source"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COMPOSITE_FORMAT,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let pixels: Vec<u8> = (0..(width as usize * height as usize * 4))
            .map(|i| (i % 251) as u8)
            .collect();
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("measure-readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit(std::iter::once(encoder.finish()));
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::Maintain::Wait);
        (buffer, stride)
    }

    fn median(values: &mut [f64]) -> f64 {
        values.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mid = values.len() / 2;
        if values.len().is_multiple_of(2) {
            (values[mid - 1] + values[mid]) / 2.0
        } else {
            values[mid]
        }
    }

    /// Percentile of an already-sorted slice.
    fn percentile(sorted: &[f64], p: f64) -> f64 {
        let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
        sorted[idx]
    }

    /// 95% bootstrap CI on `median(b) - median(a)` for paired per-batch
    /// medians, by resampling whole batches (not samples) with replacement.
    /// Signed the same way as the printed delta, so a negative interval means
    /// `b` is faster.
    fn bootstrap_ci(a: &[f64], b: &[f64], resamples: usize) -> (f64, f64) {
        let n = a.len();
        let mut deltas = Vec::with_capacity(resamples);
        // A fixed-seed xorshift: the CI has to be reproducible, and pulling in a
        // dev-dependency for randomness is not worth it.
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..resamples {
            let mut ma: Vec<f64> = Vec::with_capacity(n);
            let mut mb: Vec<f64> = Vec::with_capacity(n);
            for _ in 0..n {
                let i = (next() as usize) % n;
                ma.push(a[i]);
                mb.push(b[i]);
            }
            deltas.push(median(&mut mb) - median(&mut ma));
        }
        deltas.sort_by(|x, y| x.partial_cmp(y).unwrap());
        (percentile(&deltas, 0.025), percentile(&deltas, 0.975))
    }

    /// Run two de-padders, `iters` times each, alternating which goes first on
    /// every batch so a warm-up or a clock ramp cannot be charged to whichever
    /// variant happens to run first. Returns one median per batch per variant.
    ///
    /// The variants are closures over the buffer rather than arguments, so each
    /// one reads the same mapped memory and the harness does not have to carry
    /// the shape around.
    fn ab_depad(
        a: &dyn Fn() -> Vec<u8>,
        b: &dyn Fn() -> Vec<u8>,
        batches: usize,
        iters: usize,
    ) -> (Vec<f64>, Vec<f64>) {
        let run = |f: &dyn Fn() -> Vec<u8>| -> f64 {
            let mut samples = Vec::with_capacity(iters);
            for _ in 0..iters {
                let start = Instant::now();
                let out = f();
                samples.push(start.elapsed().as_secs_f64() * 1e6);
                std::hint::black_box(&out);
            }
            median(&mut samples)
        };

        // Warm-up batches, discarded: the first touch faults the pages in.
        run(a);
        run(b);

        let (mut a_meds, mut b_meds) = (Vec::with_capacity(batches), Vec::with_capacity(batches));
        for batch in 0..batches {
            if batch.is_multiple_of(2) {
                a_meds.push(run(a));
                b_meds.push(run(b));
            } else {
                b_meds.push(run(b));
                a_meds.push(run(a));
            }
        }
        (a_meds, b_meds)
    }

    fn report(label: &str, a: &[f64], b: &[f64], a_name: &str, b_name: &str, unit: &str) {
        let (lo, hi) = bootstrap_ci(a, b, 10_000);
        let ma = median(&mut a.to_vec());
        let mb = median(&mut b.to_vec());
        let spread = |v: &[f64]| {
            let mut s = v.to_vec();
            s.sort_by(|x, y| x.partial_cmp(y).unwrap());
            format!(
                "{:.0}..{:.0} (p25 {:.0}, p75 {:.0})",
                s[0],
                s[s.len() - 1],
                percentile(&s, 0.25),
                percentile(&s, 0.75)
            )
        };
        println!(
            "{label}\n  {a_name}: median {ma:.3} {unit}  spread {}\n  {b_name}: median {mb:.3} {unit}  spread {}\n  delta: {:+.1}% ({:+.3} {unit})  95% CI [{:+.3}, {:+.3}] {unit}",
            spread(a),
            spread(b),
            (mb - ma) / ma * 100.0,
            mb - ma,
            lo,
            hi,
        );
    }

    #[test]
    #[ignore = "measurement harness; run: cargo test --release -- --ignored --nocapture measure_"]
    fn measure_depad_against_the_row_loop_at_1080p() {
        let state = gpu::initialize_state().expect("a GPU adapter must be available");
        let (buffer, stride) = mapped_readback(&state.device, &state.queue, 1920, 1080);
        assert_eq!(stride, 1920 * 4, "1080p is the aligned case the fast path is for");

        let frame_len = 1920 * 4 * 1080;
        let slice = buffer.slice(..);
        let mapped = slice.get_mapped_range();
        let walk = || -> Vec<u8> { row_loop_depad(&mapped, 1920, 1080, stride) };
        let fast = || -> Vec<u8> { mapped[..frame_len].to_vec() };

        let (a, b) = ab_depad(&walk, &fast, 12, 30);
        report("depad 1920x1080 (aligned)", &a, &b, "row walk (before)", "stride fast path (after)", "us");

        // Diagnostic only: what is left once the per-row walk is gone. A reused
        // destination is NOT shippable -- the frame's ownership goes to JS, so
        // the buffer cannot come back -- but it is the only way to tell how much
        // of the remainder is the 8.3 MB allocation rather than the copy.
        let reuse = std::cell::RefCell::new(Vec::<u8>::new());
        let reused = || -> Vec<u8> {
            let mut reuse = reuse.borrow_mut();
            reuse.clear();
            reuse.extend_from_slice(&mapped[..frame_len]);
            std::hint::black_box(&reuse[0]);
            Vec::new()
        };
        let (c, d) = ab_depad(&fast, &reused, 12, 30);
        report("depad 1920x1080 (aligned)", &c, &d, "stride fast path (after)", "into a reused Vec (not shippable)", "us");
        drop(reuse);
        drop(mapped);
        buffer.unmap();
    }

    #[test]
    #[ignore = "measurement harness; run: cargo test --release -- --ignored --nocapture measure_"]
    fn measure_whole_frames_at_1080p() {
        let state = gpu::initialize_state().expect("a GPU adapter must be available");
        for layer_count in [1usize, 6] {
            let layers: Vec<GpuLayer> = (0..layer_count)
                .map(|i| GpuLayer {
                    rgba_data: vec![(i as u8 % 251).wrapping_add(1); 1280 * 720 * 4],
                    width: 1280,
                    height: 720,
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
                })
                .collect();
            // Warm-up, then per-batch medians.
            for _ in 0..10 {
                state
                    .pipeline
                    .composite(&state.device, &state.queue, &layers, 1920, 1080)
                    .unwrap();
            }
            let mut meds = Vec::new();
            for _ in 0..12 {
                let mut samples = Vec::with_capacity(30);
                for _ in 0..30 {
                    let start = Instant::now();
                    let frame = state
                        .pipeline
                        .composite(&state.device, &state.queue, &layers, 1920, 1080)
                        .unwrap();
                    samples.push(start.elapsed().as_secs_f64() * 1e3);
                    std::hint::black_box(&frame);
                }
                meds.push(median(&mut samples));
            }
            let mut sorted = meds.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!(
                "whole frame 1920x1080, {layer_count} layer(s): median {:.3} ms  p25 {:.3}  p75 {:.3}  min {:.3}  max {:.3}",
                median(&mut meds.clone()),
                percentile(&sorted, 0.25),
                percentile(&sorted, 0.75),
                sorted[0],
                sorted[sorted.len() - 1],
            );
        }
    }
}

