//! Geometry & transform engine.
//! Shared between the real-time preview and FFmpeg export to ensure pixel-exact consistency.

use serde::Serialize;

/// 3x3 affine transform matrix (row-major).
#[derive(Debug, Serialize)]
pub struct AffineMatrix(pub [[f32; 3]; 3]);

/// Compute an affine transform for a layer.
pub fn affine_transform(
    x: f32,
    y: f32,
    _width: f32,
    _height: f32,
    rotation_deg: f32,
    scale_x: f32,
    scale_y: f32,
    anchor_x: f32,
    anchor_y: f32,
) -> AffineMatrix {
    let rad = rotation_deg.to_radians();
    let cos_r = rad.cos();
    let sin_r = rad.sin();

    // T(position) * T(anchor) * R(rotation) * S(scale) * T(-anchor)
    // Simplified to a single 3x3 matrix:
    let tx = x + anchor_x - (anchor_x * cos_r * scale_x - anchor_y * sin_r * scale_y);
    let ty = y + anchor_y - (anchor_x * sin_r * scale_x + anchor_y * cos_r * scale_y);

    AffineMatrix([
        [cos_r * scale_x, -sin_r * scale_y, tx],
        [sin_r * scale_x, cos_r * scale_y, ty],
        [0.0, 0.0, 1.0],
    ])
}

/// Generate an FFmpeg overlay + rotate filter string for export.
/// Produces a filter segment like: `[base][overlay]overlay=x=100:y=50`
/// with scale and rotation applied to the overlay input.
pub fn to_ffmpeg_filter(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    rotation_deg: f32,
    scale_x: f32,
    scale_y: f32,
) -> String {
    let scaled_w = (width * scale_x) as i32;
    let scaled_h = (height * scale_y) as i32;
    let rad = rotation_deg.to_radians();

    let mut filter = format!("scale={scaled_w}:{scaled_h}");

    if rotation_deg.abs() > 0.01 {
        filter.push_str(&format!(",rotate={rad}:ow=rotw({rad}):oh=roth({rad}):fillcolor=none"));
    }

    filter.push_str(&format!(",overlay=x={}:y={}", x as i32, y as i32));
    filter
}
