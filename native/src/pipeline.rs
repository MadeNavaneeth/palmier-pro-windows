//! GPU Render Pipeline — creates the wgpu pipeline for multi-layer compositing.
//!
//! Architecture:
//! - One render pass per frame, with one draw call per layer (painter's algorithm).
//! - Each layer uploads its RGBA texture, binds its transform uniform, and draws a quad.
//! - The output render target is read back as an RGBA buffer.

use crate::geometry;
use crate::gpu;
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

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

// ─── Pipeline state ──────────────────────────────────────────────────────────

pub struct CompositorPipeline {
    render_pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
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
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
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
        }
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
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
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
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
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
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
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
        // wgpu requires rows aligned to 256 bytes
        let padded_bytes_per_row = (bytes_per_row + 255) & !255;
        let output_buffer_size = (padded_bytes_per_row * output_height) as u64;

        let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("output-readback-buffer"),
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

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
        let (tx, rx) = std::sync::mpsc::channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            tx.send(result).unwrap();
        });
        device.poll(wgpu::Maintain::Wait);

        rx.recv()
            .map_err(|e| format!("Buffer map channel error: {e}"))?
            .map_err(|e| format!("Buffer map failed: {e}"))?;

        // Copy data, removing row padding
        let mapped = buffer_slice.get_mapped_range();
        let mut result = Vec::with_capacity((output_width * output_height * 4) as usize);
        for row in 0..output_height {
            let start = (row * padded_bytes_per_row) as usize;
            let end = start + (output_width * 4) as usize;
            result.extend_from_slice(&mapped[start..end]);
        }

        drop(mapped);
        output_buffer.unmap();

        Ok(result)
    }
}

// ─── Singleton pipeline (lazily created after GPU init) ──────────────────────

use std::sync::OnceLock;

static PIPELINE: OnceLock<CompositorPipeline> = OnceLock::new();

pub fn get_or_create_pipeline() -> Option<&'static CompositorPipeline> {
    let state = gpu::get_state()?;
    Some(PIPELINE.get_or_init(|| CompositorPipeline::new(&state.device)))
}
