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

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-5;

    fn near(a: f32, b: f32) -> bool {
        (a - b).abs() < EPS
    }

    /// Apply the matrix to a point in layer-local pixel coordinates.
    fn apply(m: &AffineMatrix, x: f32, y: f32) -> (f32, f32) {
        (
            m.0[0][0] * x + m.0[0][1] * y + m.0[0][2],
            m.0[1][0] * x + m.0[1][1] * y + m.0[1][2],
        )
    }

    #[test]
    fn the_homogeneous_row_is_the_identity() {
        let m = affine_transform(10.0, 20.0, 100.0, 50.0, 33.0, 1.5, 0.5, 7.0, 9.0);
        assert_eq!(m.0[2], [0.0, 0.0, 1.0]);
    }

    #[test]
    fn an_untransformed_layer_maps_its_origin_to_its_position() {
        let m = affine_transform(100.0, 50.0, 1920.0, 1080.0, 0.0, 1.0, 1.0, 0.0, 0.0);
        assert_eq!(m.0[0][0], 1.0);
        assert_eq!(m.0[0][1], 0.0);
        assert_eq!(m.0[1][0], 0.0);
        assert_eq!(m.0[1][1], 1.0);
        assert!((m.0[0][2] - 100.0).abs() < EPS);
        assert!((m.0[1][2] - 50.0).abs() < EPS);
        assert_eq!(apply(&m, 0.0, 0.0), (100.0, 50.0));
    }

    /// The layer's own size is not part of the transform: the shader builds the
    /// quad from the texture dimensions and only the matrix is uploaded. Pinned
    /// so a future "anchor as a fraction of size" change is a deliberate one.
    #[test]
    fn the_layer_size_does_not_affect_the_transform() {
        let small = affine_transform(10.0, 10.0, 32.0, 32.0, 0.0, 1.0, 1.0, 0.0, 0.0);
        let large = affine_transform(10.0, 10.0, 3840.0, 2160.0, 0.0, 1.0, 1.0, 0.0, 0.0);
        assert_eq!(small.0, large.0);
    }

    #[test]
    fn scale_stretches_the_basis_vectors_per_axis() {
        let m = affine_transform(0.0, 0.0, 10.0, 10.0, 0.0, 2.0, 0.5, 0.0, 0.0);
        assert!((m.0[0][0] - 2.0).abs() < EPS);
        assert!((m.0[1][1] - 0.5).abs() < EPS);
        let (x, y) = apply(&m, 4.0, 4.0);
        assert!(near(x, 8.0) && near(y, 2.0), "got ({x}, {y})");
    }

    #[test]
    fn a_quarter_turn_maps_x_to_down_and_leaves_y_alone() {
        // 90 degrees clockwise in a top-left-origin pixel space.
        let m = affine_transform(0.0, 0.0, 10.0, 10.0, 90.0, 1.0, 1.0, 0.0, 0.0);
        let (x, y) = apply(&m, 1.0, 0.0);
        assert!(near(x, 0.0) && near(y, 1.0), "got ({x}, {y})");
        let (x, y) = apply(&m, 0.0, 1.0);
        assert!(near(x, -1.0) && near(y, 0.0), "got ({x}, {y})");
    }

    #[test]
    fn rotation_and_scale_compose_on_the_same_axes() {
        // 90 degrees with a 2x scale: x travels 2 units down, y 2 units left.
        let m = affine_transform(0.0, 0.0, 10.0, 10.0, 90.0, 2.0, 2.0, 0.0, 0.0);
        let (x, y) = apply(&m, 1.0, 0.0);
        assert!(near(x, 0.0) && near(y, 2.0), "got ({x}, {y})");
    }

    /// The anchor is the pivot: the layer's anchor point never moves, so a
    /// rotated layer spins about its anchor instead of the canvas origin.
    #[test]
    fn the_anchor_is_the_pivot_of_the_transform() {
        let (ax, ay) = (32.0, 18.0);
        let (x, y) = (100.0, 50.0);
        let m = affine_transform(x, y, 64.0, 36.0, 30.0, 1.0, 1.0, ax, ay);
        let (px, py) = apply(&m, ax, ay);

        assert!(near(px, x + ax), "anchor moved in x: {px}");
        assert!(near(py, y + ay), "anchor moved in y: {py}");
    }

    #[test]
    fn a_full_turn_returns_the_layer_to_its_place() {
        let m = affine_transform(17.0, 23.0, 10.0, 10.0, 360.0, 1.0, 1.0, 0.0, 0.0);
        let (x, y) = apply(&m, 3.0, 4.0);
        assert!(near(x, 20.0) && near(y, 27.0), "got ({x}, {y})");
    }

    #[test]
    fn the_ffmpeg_filter_encodes_scale_and_overlay_position() {
        assert_eq!(
            to_ffmpeg_filter(100.0, 50.0, 200.0, 100.0, 0.0, 0.5, 2.0),
            "scale=100:200,overlay=x=100:y=50"
        );
    }

    #[test]
    fn the_ffmpeg_filter_only_rotates_above_the_threshold() {
        // Sub-0.01 degree is treated as no rotation, so an untouched clip does
        // not pay for a rotate filter (which also grows the frame).
        assert_eq!(
            to_ffmpeg_filter(0.0, 0.0, 10.0, 10.0, 0.005, 1.0, 1.0),
            "scale=10:10,overlay=x=0:y=0"
        );
        assert!(to_ffmpeg_filter(0.0, 0.0, 10.0, 10.0, 90.0, 1.0, 1.0).contains("rotate=1.5707964"));
    }

    #[test]
    fn the_ffmpeg_filter_truncates_fractional_positions() {
        assert!(to_ffmpeg_filter(10.9, -0.5, 10.0, 10.0, 0.0, 1.0, 1.0).ends_with("overlay=x=10:y=0"));
    }
}

