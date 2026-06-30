//! Multi-layer compositor. Takes layer descriptors and produces a composited RGBA frame.
//! Phase 0/1: CPU fallback compositor. Phase 3+ will use the GPU render pipeline.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct LayerDescriptor {
    pub source_path: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub opacity: f32,
    #[serde(default)]
    pub rotation_deg: f32,
    #[serde(default)]
    pub z_index: i32,
}

/// Composite layers into an RGBA buffer.
/// Current implementation: CPU-based alpha blending (sufficient for Phase 0-2).
/// Phase 3 upgrade: wgpu render pipeline with texture atlas.
pub fn composite(
    layers: &[LayerDescriptor],
    output_width: u32,
    output_height: u32,
) -> std::result::Result<Vec<u8>, String> {
    let pixel_count = (output_width * output_height) as usize;
    let mut buffer = vec![0u8; pixel_count * 4]; // RGBA, black transparent

    // Sort layers by z_index (painter's algorithm)
    let mut sorted_layers: Vec<&LayerDescriptor> = layers.iter().collect();
    sorted_layers.sort_by_key(|l| l.z_index);

    for layer in sorted_layers {
        // Load the source image
        let img = image::open(&layer.source_path)
            .map_err(|e| format!("Failed to load '{}': {e}", layer.source_path))?;

        let resized = img.resize_exact(
            layer.width as u32,
            layer.height as u32,
            image::imageops::FilterType::Lanczos3,
        );
        let rgba = resized.to_rgba8();

        // Alpha-blend onto the output buffer
        let lx = layer.x as i32;
        let ly = layer.y as i32;

        for (row_idx, row) in rgba.rows().enumerate() {
            let dst_y = ly + row_idx as i32;
            if dst_y < 0 || dst_y >= output_height as i32 {
                continue;
            }
            for (col_idx, pixel) in row.enumerate() {
                let dst_x = lx + col_idx as i32;
                if dst_x < 0 || dst_x >= output_width as i32 {
                    continue;
                }
                let dst_offset = ((dst_y as u32 * output_width + dst_x as u32) * 4) as usize;
                let src_alpha = (pixel[3] as f32 / 255.0) * layer.opacity;

                if src_alpha <= 0.0 {
                    continue;
                }

                let inv_alpha = 1.0 - src_alpha;
                buffer[dst_offset] =
                    (pixel[0] as f32 * src_alpha + buffer[dst_offset] as f32 * inv_alpha) as u8;
                buffer[dst_offset + 1] =
                    (pixel[1] as f32 * src_alpha + buffer[dst_offset + 1] as f32 * inv_alpha) as u8;
                buffer[dst_offset + 2] =
                    (pixel[2] as f32 * src_alpha + buffer[dst_offset + 2] as f32 * inv_alpha) as u8;
                buffer[dst_offset + 3] =
                    ((src_alpha + buffer[dst_offset + 3] as f32 / 255.0 * inv_alpha) * 255.0) as u8;
            }
        }
    }

    Ok(buffer)
}
