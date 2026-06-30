// Palmier Compositor — GPU compositing shader with per-layer blend modes.
//
// Each layer is drawn as a transformed quad. The fragment shader reads the
// current backdrop (the accumulated composite, supplied as a separate sampled
// texture) and the layer texture, then applies a W3C blend function and the
// standard compositing equation. Opacity scales the source alpha so it fades
// the blended result (Photoshop/Premiere semantics).
//
// Blend mode indices MUST match src/shared/types/blend-mode.ts and lib.rs.
const BLEND_NORMAL: u32      = 0u;
const BLEND_MULTIPLY: u32    = 1u;
const BLEND_SCREEN: u32      = 2u;
const BLEND_OVERLAY: u32     = 3u;
const BLEND_DARKEN: u32      = 4u;
const BLEND_LIGHTEN: u32     = 5u;
const BLEND_COLOR_DODGE: u32 = 6u;
const BLEND_COLOR_BURN: u32  = 7u;
const BLEND_HARD_LIGHT: u32  = 8u;
const BLEND_SOFT_LIGHT: u32  = 9u;
const BLEND_DIFFERENCE: u32  = 10u;
const BLEND_EXCLUSION: u32   = 11u;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct LayerUniforms {
    transform_row0: vec4<f32>, // a, b, tx, _pad
    transform_row1: vec4<f32>, // c, d, ty, _pad
    params: vec4<f32>,         // opacity, canvas_width, canvas_height, blend_mode
    params2: vec4<f32>,        // wipe_mode, wipe_progress, wipe_softness, _pad
};

@group(0) @binding(0) var<uniform> layer: LayerUniforms;
@group(0) @binding(1) var layer_texture: texture_2d<f32>;
@group(0) @binding(2) var layer_sampler: sampler;
@group(0) @binding(3) var backdrop_texture: texture_2d<f32>;

var<private> QUAD_POS: array<vec2<f32>, 6> = array(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    var out: VertexOutput;
    let pos = QUAD_POS[idx];
    out.uv = pos;

    let tex_size = vec2<f32>(textureDimensions(layer_texture));
    let local = vec2<f32>(pos.x * tex_size.x, pos.y * tex_size.y);

    let a = layer.transform_row0.x;
    let b = layer.transform_row0.y;
    let tx = layer.transform_row0.z;
    let c = layer.transform_row1.x;
    let d = layer.transform_row1.y;
    let ty = layer.transform_row1.z;

    let world_x = a * local.x + b * local.y + tx;
    let world_y = c * local.x + d * local.y + ty;

    let canvas_w = layer.params.y;
    let canvas_h = layer.params.z;
    let ndc_x = (world_x / canvas_w) * 2.0 - 1.0;
    let ndc_y = 1.0 - (world_y / canvas_h) * 2.0;

    out.position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    return out;
}

// ─── Blend functions (per channel, W3C separable modes) ──────────────────────

fn soft_light_channel(cb: f32, cs: f32) -> f32 {
    if (cs <= 0.5) {
        return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    }
    var d: f32;
    if (cb <= 0.25) {
        d = ((16.0 * cb - 12.0) * cb + 4.0) * cb;
    } else {
        d = sqrt(cb);
    }
    return cb + (2.0 * cs - 1.0) * (d - cb);
}

fn blend_channel(cb: f32, cs: f32, mode: u32) -> f32 {
    if (mode == BLEND_MULTIPLY) { return cb * cs; }
    if (mode == BLEND_SCREEN) { return cb + cs - cb * cs; }
    if (mode == BLEND_OVERLAY) {
        if (cb <= 0.5) { return 2.0 * cb * cs; }
        return 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
    }
    if (mode == BLEND_DARKEN) { return min(cb, cs); }
    if (mode == BLEND_LIGHTEN) { return max(cb, cs); }
    if (mode == BLEND_COLOR_DODGE) {
        if (cb <= 0.0) { return 0.0; }
        if (cs >= 1.0) { return 1.0; }
        return min(1.0, cb / (1.0 - cs));
    }
    if (mode == BLEND_COLOR_BURN) {
        if (cb >= 1.0) { return 1.0; }
        if (cs <= 0.0) { return 0.0; }
        return 1.0 - min(1.0, (1.0 - cb) / cs);
    }
    if (mode == BLEND_HARD_LIGHT) {
        if (cs <= 0.5) { return 2.0 * cs * cb; }
        return 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb);
    }
    if (mode == BLEND_SOFT_LIGHT) { return soft_light_channel(cb, cs); }
    if (mode == BLEND_DIFFERENCE) { return abs(cb - cs); }
    if (mode == BLEND_EXCLUSION) { return cb + cs - 2.0 * cb * cs; }
    return cs; // BLEND_NORMAL
}

// ─── Wipe transition mask ────────────────────────────────────────────────────
// mode: 0=none, 1=left, 2=right, 3=up, 4=down. Returns alpha multiplier 0..1.
fn wipe_mask(mode: u32, progress: f32, softness: f32, uv: vec2<f32>) -> f32 {
    if (mode == 0u) { return 1.0; }
    let soft = max(softness, 0.0001);
    if (mode == 1u) {
        let edge = progress;
        return 1.0 - smoothstep(edge - soft, edge + soft, uv.x);
    }
    if (mode == 2u) {
        let edge = 1.0 - progress;
        return smoothstep(edge - soft, edge + soft, uv.x);
    }
    if (mode == 3u) {
        let edge = progress;
        return 1.0 - smoothstep(edge - soft, edge + soft, uv.y);
    }
    if (mode == 4u) {
        let edge = 1.0 - progress;
        return smoothstep(edge - soft, edge + soft, uv.y);
    }
    return 1.0;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let src = textureSample(layer_texture, layer_sampler, in.uv);
    let opacity = layer.params.x;
    let mode = u32(layer.params.w + 0.5);

    // Wipe transition mask (alpha only).
    let wipe_m = u32(layer.params2.x + 0.5);
    let mask = wipe_mask(wipe_m, layer.params2.y, layer.params2.z, in.uv);

    // Backdrop (accumulated composite) at this pixel.
    let canvas = vec2<f32>(layer.params.y, layer.params.z);
    let screen_uv = in.position.xy / canvas;
    let backdrop = textureSample(backdrop_texture, layer_sampler, screen_uv);

    let cs = src.rgb;
    let cb = backdrop.rgb;
    let alpha_s = src.a * opacity * mask;
    let alpha_b = backdrop.a;

    // Per-channel blend.
    let blended = vec3<f32>(
        blend_channel(cb.r, cs.r, mode),
        blend_channel(cb.g, cs.g, mode),
        blend_channel(cb.b, cs.b, mode),
    );

    // W3C compositing: premultiplied output, then un-premultiply.
    let alpha_o = alpha_s + alpha_b * (1.0 - alpha_s);
    let co = alpha_s * (1.0 - alpha_b) * cs
           + alpha_s * alpha_b * blended
           + (1.0 - alpha_s) * alpha_b * cb;

    if (alpha_o <= 0.0001) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
    return vec4<f32>(co / alpha_o, alpha_o);
}
