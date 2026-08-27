/**
 * Edge effects helpers for DaVinci-style edge rounding and edge softness
 * (upstream PR #369).
 *
 * Both values are normalized 0–1 on the Clip type.  This module owns:
 * - The predicate for "does this clip have active edge effects?"
 * - The FFmpeg geq alpha-expression builder for export
 */

import type { Clip } from '../types/project';

/** Returns true when the clip carries non-default edge treatments. */
export function hasEdgeEffects(clip: Clip): boolean {
  return (clip.edgeRounding ?? 0) > 0 || (clip.edgeSoftness ?? 0) > 0;
}

/**
 * Builds the FFmpeg `geq` alpha-expression string for a clip's edge
 * effects.  The expression is evaluated per-pixel on the *scaled* frame
 * (after `scale=` in the filter chain) so dimensions match `W` and `H`
 * as FFmpeg symbols.
 *
 * The formula:
 *   1. Compute the minimum straight-edge distance `d = min(X, W-1-X, Y, H-1-Y)`.
 *   2. In corner quadrants (dx < R and dy), switch to the euclidean
 *      distance from the arc centre: `sqrt((R-dx)² + (R-dy)²)`.
 *   3. Map that distance to alpha via a hard zone (radius) and a linear
 *      softness ramp.
 *
 * When only rounding is active (softness = 0) the ramp degenerates to a
 * hard step.  When only softness is active (rounding = 0) the entire
 * edge is feathered.
 */
export function buildEdgeGeqExpr(
  edgeRounding: number,
  edgeSoftness: number,
  canvasWidth: number,
  canvasHeight: number,
): string {
  const R = Math.min(Math.max(edgeRounding, 0), 1) * Math.min(canvasWidth, canvasHeight) * 0.5;
  const S = Math.min(Math.max(edgeSoftness, 0), 1) * Math.min(canvasWidth, canvasHeight) * 0.5;

  // The geq alpha expression works with FFmpeg pixel coordinates (X, Y)
  // and frame dimensions (W, H).
  //
  // Edge distance computation:
  //   dx = min(X, W-1-X)       -- distance to nearest vertical edge
  //   dy = min(Y, H-1-Y)       -- distance to nearest horizontal edge
  //   d  = min(dx, dy)          -- straight-edge distance
  //
  // Corner detection: when both dx < R and dy < R we are in a corner
  // quadrant and must use the euclidean distance from the arc centre
  // instead:
  //   cornerDist = sqrt((R - dx)² + (R - dy)²)
  //   effectiveD = inCorner ? cornerDist : d
  //
  // Alpha mapping (R = corner radius, S = softness width):
  //   effectiveD >= R + S  →  255   (fully inside)
  //   effectiveD >= R      →  255 * (1 - (effectiveD - R) / S)  (soft ramp)
  //   effectiveD <  R      →  0     (outside rounded rect)

  // We encode this as a single geq alpha expression.  Because geq doesn't
  // support local variables, we inline the maths.

  if (R <= 0 && S <= 0) return 'alpha(X,Y)'; // passthrough

  // Straight-edge distance branch (non-corner):
  //   d = min(X, W-1-X, Y, H-1-Y)
  //   When R == 0: alpha = clamp(255 * d / S, 0, 255)
  //   When S == 0: alpha = d >= R ? 255 : 0
  //   When both:   alpha = d >= R+S ? 255 : d >= R ? 255*(1-(d-R)/S) : 0

  // Corner distance branch:
  //   cornerDist = sqrt((R-dx)² + (R-dy)²)  where dx=min(X,W-1-X), dy=min(Y,H-1-Y)
  //   Same alpha mapping applied to cornerDist instead of d.

  // Build the expression piecewise.  We use ternary-style `if()` calls.
  const r2 = (R * R).toFixed(4);

  // clang-format off
  const expr = [
    // 1. Compute dx, dy (straight-edge distances)
    'min(min(X,W-1-X),min(Y,H-1-Y))',
    // We'll call this 'd' but geq doesn't have variables, so inline later.

    // For the corner branch, compute the euclidean distance:
    //   sqrt((R - min(X,W-1-X))^2 + (R - min(Y,H-1-Y))^2)
    // but only when both terms are positive (i.e. in a corner quadrant).

    // Combined expression:
    //   dx = min(X, W-1-X)
    //   dy = min(Y, H-1-Y)
    //   inCorner = lt(dx, R) * lt(dy, R)   (1 if corner, 0 otherwise)
    //   cornerDist2 = (R-dx)^2 * inCorner + (R-dy)^2 * inCorner
    //   effectiveD = inCorner ? sqrt(cornerDist2) : min(dx,dy)

    // Since geq doesn't have booleans, we use arithmetic:
    //   inCornerMask = (1 + sign(R-1-dx)) * (1 + sign(R-1-dy)) / 4
    //   ... this gets messy.  Let's use a cleaner formulation.

    // Pragmatic approach: compute BOTH the straight and corner distances
    // and take the minimum (which equals the correct one in each region).
    // This works because:
    //   - Outside corners: cornerDist > d, so min = d (correct)
    //   - Inside corners:  cornerDist < R while d may also < R
    //     but the actual boundary is at cornerDist = R, not d = R.
    //     Using min(cornerDist, d) gives a conservative (smaller) distance,
    //     which means the alpha goes to zero a bit early — the rounding
    //     is slightly more aggressive.  Acceptable approximation for
    //     FFmpeg export where the corner detail is sub-pixel anyway.
    //
    // Actually, let me just compute the correct one directly.
  ].join('\n');

  // Build the real expression string:
  const parts: string[] = [];

  if (R > 0 && S > 0) {
    // Both rounding and softness active
    parts.push(
      // dx, dy, d (straight-edge distance)
      `if(lt(min(min(X,W-1-X),min(Y,H-1-Y)),0),0,`,
      // Check if in corner quadrant
      `if(or(lt(min(X,W-1-X),${R.toFixed(4)}),lt(min(Y,H-1-Y),${R.toFixed(4)})),`,
      // Corner: use euclidean distance from arc centre
      `clip(if(ge(sqrt(pow(max(0,${R.toFixed(4)}-min(X,W-1-X)),2)+pow(max(0,${R.toFixed(4)}-min(Y,H-1-Y)),2)),${(R + S).toFixed(4)}),255,`,
      `if(ge(sqrt(pow(max(0,${R.toFixed(4)}-min(X,W-1-X)),2)+pow(max(0,${R.toFixed(4)}-min(Y,H-1-Y)),2)),${R.toFixed(4)}),`,
      `${(255 / S).toFixed(4)}*(${(R + S).toFixed(4)}-sqrt(pow(max(0,${R.toFixed(4)}-min(X,W-1-X)),2)+pow(max(0,${R.toFixed(4)}-min(Y,H-1-Y)),2))),0)),0,255)`,
      // Straight edge: use min(dx,dy)
      `,`,
      `clip(if(ge(min(min(X,W-1-X),min(Y,H-1-Y)),${(R + S).toFixed(4)}),255,`,
      `if(ge(min(min(X,W-1-X),min(Y,H-1-Y)),${R.toFixed(4)}),`,
      `${(255 / S).toFixed(4)}*(${(R + S).toFixed(4)}-min(min(X,W-1-X),min(Y,H-1-Y))),0)),0,255))`,
      `)`,
    );
  } else if (R > 0) {
    // Rounding only (hard step at radius)
    parts.push(
      `if(or(lt(min(X,W-1-X),${R.toFixed(4)}),lt(min(Y,H-1-Y),${R.toFixed(4)})),`,
      // Corner: check euclidean distance
      `if(ge(sqrt(pow(max(0,${R.toFixed(4)}-min(X,W-1-X)),2)+pow(max(0,${R.toFixed(4)}-min(Y,H-1-Y)),2)),${R.toFixed(4)}),255,0),`,
      // Straight edge: simple min check
      `if(ge(min(min(X,W-1-X),min(Y,H-1-Y)),${R.toFixed(4)}),255,0))`,
    );
  } else {
    // Softness only (linear ramp from edges, no rounding)
    parts.push(
      `clip(${(255 / S).toFixed(4)}*min(min(X,W-1-X),min(Y,H-1-Y)),0,255)`,
    );
  }

  return parts.join('');
}

/**
 * Clamp a numeric edge value (from Clip type) to the valid 0–1 range.
 * Returns 0 for NaN, Infinity, or negative values.
 */
export function clampEdgeValue(v: number | undefined): number {
  if (!Number.isFinite(v ?? NaN)) return 0;
  return Math.min(1, Math.max(0, v ?? 0));
}
