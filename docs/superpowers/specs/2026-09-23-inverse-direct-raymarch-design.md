# Inverse Radial Direct Raymarch Design

## Purpose

Replace the Draft, Standard, and High render path for Inverse Radial shadows
with a renderer that always samples the original source image. The experiment
must remove the convergence corruption caused by recursively resampling an
already-rasterized shadow while remaining usable at Standard quality.

This is a performance feasibility experiment. If Standard quality is not
usable, or if the existing appearance regresses, the implementation changes
will be discarded and the repository will return to r7.

## Scope

- Change Inverse Radial at Draft, Standard, and High quality.
- Keep Directional, Radial, and Ultra behavior unchanged from r7.
- Preserve the current controls, packed shadow-buffer format, styling, Fade,
  texture mapping, blur, and compositing behavior.
- Do not introduce a renderer switch at a particular Length or convergence
  threshold.

## Rendering Architecture

Add a direct Inverse Radial pixel shader and call it instead of
`render_radial_scale` when `shadow_type == 2` and quality is below Ultra.
`render_radial_scale` remains the Radial renderer. Ultra continues using the
existing direct raymarch shader.

For each output pixel `P`, projection origin `O`, target scale `s`, and normalized
shadow distance `t`, the source coordinate is:

```text
Q(t) = O + (P - O) / pow(s, t)
```

The shader must never read a shadow produced by an earlier pass. Every alpha
and source-coordinate lookup comes directly from the unexpanded source texture.
This removes recursive raster quantization from the Inverse path.

## Clipped Sampling Interval

Let `u = pow(s, -t)`. For an inverse projection, `u` increases monotonically
from `1` to `1 / s`. Rewrite the source coordinate as:

```text
Q(u) = O + (P - O) * u
```

Intersect this ray with the source image's axis-aligned rectangle. The x and y
slabs produce a valid `[u_min, u_max]` interval. Intersect it with
`[1, 1 / s]`. If the result is empty, return transparent without sampling the
source. Convert the remaining endpoints back to normalized distances with:

```text
t = log(u) / -log(s)
```

Coordinates parallel to a slab are valid only when the constant coordinate is
inside that slab. Calculations must guard scales and divisors with a small
epsilon.

## Sampling and Quality

Compute the source-space distance between `Q(u_min)` and `Q(u_max)`. Sample only
that segment using the existing quality spacing:

- Draft: 4 source pixels
- Standard: 2 source pixels
- High: 1 source pixel

Always include both interval endpoints. Cap the loop at `MAX_DIRECT_SAMPLES`.
Accumulate coverage and retain the first non-transparent distance and source
coordinate using the existing packed-buffer contract. Stop early once coverage
is effectively opaque.

Apply the same clipped-interval calculation to Inverse boundary refinement so
`edge_antialias` cannot fall back to a full 0-to-1 convergence scan. Radial and
Directional refinement retain their existing calculations.

## Output Contract

The direct shader must produce the same packed channels consumed by the current
style pipeline:

- R: encoded first source x coordinate
- G: first-hit normalized distance multiplied by coverage
- B: encoded first source y coordinate
- A: accumulated coverage

The existing `style_and_filter_shadow` pipeline remains responsible for Fade,
colors, textures, post smoothing, and Blur Shadow.

## Verification

Automated tests must:

- compile every embedded HLSL shader;
- exercise ray/rectangle interval clipping for hits, misses, parallel axes, and
  the convergence endpoint;
- verify the quality spacing passed to the direct Inverse renderer;
- verify that Directional, Radial, and Ultra keep their existing dispatch paths;
- verify the packed first-hit and coverage calculations with constant shader
  inputs.

Manual verification in AviUtl must compare r7 and the experiment for:

- short, near-converged, and fully converged Length values;
- Draft, Standard, High, and Ultra;
- text and sparse alpha graphics;
- Fade, shadow texture, color, opacity, and blur behavior;
- interactive performance at Standard quality.

The experiment succeeds only if convergence remains continuous and Standard is
practically interactive. Otherwise the implementation is discarded rather than
adding another approximation to the recursive renderer.
