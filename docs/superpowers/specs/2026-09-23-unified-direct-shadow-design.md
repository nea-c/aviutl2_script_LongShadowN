# Unified Direct Shadow Renderer Design

## Goal

Use clipped direct-source sampling for every Radial and Inverse Radial
quality tier, plus High and Ultra Directional. Preserve the existing fast
Directional renderer for Draft and Standard. The new paths should match or
exceed the current High and Ultra appearance while remaining responsive and
eliminating the convergence discontinuities caused by recursive Radial
resampling.

Exact pixel equality with the legacy renderers is not required. The acceptance
target is equivalent or better visible quality, stable animation as parameters
change, and no regression in interactive performance for the replaced quality
tiers.

## Scope

The renderer matrix is:

| Shadow type | Draft | Standard | High | Ultra |
| --- | --- | --- | --- | --- |
| Directional | Legacy fast | Legacy fast | Direct | Direct |
| Radial | Direct | Direct | Direct | Direct |
| Inverse Radial | Direct | Direct | Direct | Direct |

Fade, color, texture, Blur Shadow, object compositing, supersampling, padding,
and source-position selection retain their existing user-visible behavior.
The four quality choices remain available.

## Architecture

### Shared direct renderer

Add one `direct_raymarch_shadow` pixel shader and one Lua entry point,
`render_direct_shadow`. The shader samples the original source rather than an
already-resampled shadow buffer. It emits the existing packed contract:

- source X coordinate;
- normalized first-hit distance weighted by coverage;
- source Y coordinate;
- accumulated coverage.

Keeping this contract allows the existing resolve, Fade, texture, color, blur,
and compositing passes to remain unchanged.

The shader separates geometry from traversal:

- a Directional interval helper clips a translated line segment against the
  source rectangle;
- a Projection interval helper clips the scaling ray used by both Radial and
  Inverse Radial;
- one common traversal loop samples the returned interval and constructs the
  packed result.

The helpers remain small and independently testable. The common loop owns alpha
sampling, first-hit selection, coverage accumulation, endpoint handling, and
the sample cap.

### Dispatch

Lua dispatches Directional Draft and Standard to the existing
`render_fast_directional`. Directional High and Ultra, and every Radial and
Inverse Radial quality, dispatch to `render_direct_shadow`.

Once the direct paths pass automated and manual verification, remove the unused
recursive Radial renderer and the legacy full-range Ultra raymarch. Retain the
fast Directional shaders and buffers because Draft and Standard still use them.

### Edge refinement

Generalize the current Direct Inverse refinement branch to every Direct mode.
Rename `inverse_quality_step` to `direct_quality_step`. A positive value marks a
Direct-rendered shadow and supplies the same spacing used by the main renderer.
The edge pass must use the same interval helper and traversal parameterization
as the main pass. Directional Draft and Standard continue using their existing
legacy refinement behavior.

## Sampling

The requested source-space spacing and refinement counts remain:

| Quality | Requested spacing | Edge refinement samples |
| --- | ---: | ---: |
| Draft | 4 px | 4 |
| Standard | 2 px | 8 |
| High | 1 px | 12 |
| Ultra | 0.5 px | 16 |

Directional samples uniformly in translation distance. Radial and Inverse
Radial sample uniformly in original-source coordinate change so projection
convergence cannot reduce the effective source resolution.

Both interval endpoints are always sampled. If the requested count exceeds
`MAX_DIRECT_SAMPLES` (8001), distribute all 8001 samples uniformly across the
complete clipped interval instead of truncating the ray. The effective spacing
may become coarser, but neither endpoint nor the shadow terminus may disappear.

First-hit distance is derived from the actual transform parameter, not the
integer sample index. Directional uses normalized translation distance. Radial
and Inverse Radial convert the sampled projection scale to normalized logarithmic
progress relative to `target_scale`. This keeps Fade and 1D texture mapping
consistent across clipping and sample-cap changes.

## Boundary and Failure Handling

- A ray that does not intersect the source rectangle returns transparency.
- A zero Length follows the existing no-shadow path.
- Projection scales extremely close to one avoid unstable division and use a
  numerically safe short interval calculation without switching the whole frame
  to a different rendering algorithm.
- Parallel or nearly parallel interval axes are ignored when the point lies
  inside that axis slab and reject the ray when it lies outside.
- Existing finite-position, image-dimension, buffer-area, and padding clamps
  remain in force.
- The sample cap always covers the complete valid interval.

## Compatibility and Cleanup

No parameters, quality choices, defaults, or saved-project numeric values are
changed. The output buffer contract and all post-processing inputs remain
compatible. Shader and Lua names that are no longer referenced after the
cutover should be removed so there is only one Direct implementation to fix in
future.

## Verification

Automated tests will cover:

- Directional and Projection interval intersections, misses, parallel axes,
  endpoints, and near-degenerate transforms;
- the renderer matrix for all three shadow types and four quality tiers;
- 4, 2, 1, and 0.5 pixel requested spacing;
- complete-interval redistribution at the 8001-sample cap;
- inclusion of both interval endpoints;
- transform-derived first-hit distance for Fade and 1D textures;
- shared Direct refinement and legacy Directional refinement routing;
- preservation of the packed output contract and downstream parameter wiring;
- compilation of every embedded HLSL shader;
- the existing regression tests for Opacity, Mix, Blur Shadow, object
  compositing, and outline artifacts.

Manual comparison will cover short and long shadows, animation through Radial
and Inverse convergence, positions outside the source, supersampling, Blur
Shadow, and each replaced quality tier. Acceptance requires stable animation,
no convergence discontinuity or fragments, appearance at least as clean as the
corresponding legacy quality, and no noticeable interaction slowdown in the
replaced paths.
