# Directional Layered Blur Experiment

## Goal and status

Test whether the dark wedges seen with Directional, Fade 50, and Blur Shadow
40 come from collapsing near and far shadow contributions into one distance
before blurring. Success means the wedges disappear without bringing back the
object-edge outline, an AA gap, or a hard Fade boundary. The screenshot is
evidence of the symptom, not proof of this cause; visual confirmation in
AviUtl2 remains necessary.

The user approved a Directional-only trial. Radial and Inverse Radial remain
unchanged until the trial's appearance and cost are evaluated. Blur Shadow 0
always retains the existing single-layer path.

## Evidence and approaches

The current Direct renderer emits one coverage and one weighted distance per
pixel. `style_shadow` produces one premultiplied image. `spread_blur_distance`
and `blur_shadow` then operate on that flattened image before the original
object is composited. The original object therefore remains in front, but
near and far portions of the shadow are no longer distinguishable to the blur.
The r7 blur also accepted a flattened shadow, so r8 is a plausible exposure of
the problem, not a proven point where depth information first disappeared.

Considered approaches:

1. Adjust the existing distance field or blur weights. This is cheap but
   cannot recover contributions that the Direct pass already discarded.
2. Preserve two ordered shadow layers and blur them separately. This adds
   passes and memory, but directly tests the proposed mechanism. **Chosen for
   this trial.**
3. Blur every ray sample before compositing. This best preserves ordering but
   multiplies work by ray samples and blur taps, so it is unsuitable for the
   interactive renderer.

## Data flow

For Directional with Blur Shadow above zero, traverse the same source ray in
front-to-back order for two outputs. The front layer is the first continuous
shadow-support interval on the ray; later intervals form the rear layer.
Support means root-corrected source coverage above `1/255`, evaluated before
Fade. One sampled position below that threshold ends an interval. Use the
same rule at every quality level. This is intentionally a two-layer
approximation: distinct later intervals share the rear layer. Determine
interval transitions from source support, not a fixed 50% distance split,
so no global depth threshold can become a visible band.
Both outputs retain the existing source-coordinate, premultiplied-distance,
geometry, and coverage contract. The two passes must use identical sample
positions, Fade weights, root subtraction, quality spacing, and termination
rules. Because the shader interface has one RGBA target, the initial trial may
evaluate the same ray twice with a layer selector; no new user-facing control
is added.

The front coverage is the running maximum of faded, root-corrected samples in
its interval. Rear coverage is the running maximum of later samples. Preserve
the **raw rear layer through blur**, even where the front is opaque: rear blur
must be able to spread beyond the front silhouette. Each layer's distance is
accumulated from only its own coverage increments, so its blur radius does not
inherit another layer's distance. After blur, retain only rear coverage not
already covered by front. For front alpha `F` and rear alpha `R`, the visible
rear premultiplied color/alpha is multiplied by
`max(0, R - F) / max(R, 1e-6)`; the combined alpha is `max(F, R)`. This matches
the current max-union alpha before blur, avoids double-counting correlated
samples, and keeps rear blur present until the last possible stage.

Resolve, edge-refine, source-color, style, distance-spread, and two-axis blur
each layer independently. Reuse existing shaders where their single-layer
contract still holds; add only the layer selection and final layer-combine
logic needed by the trial. Combine blurred rear behind blurred front using
the residual rule above, apply global Shadow Opacity exactly once, then run the
existing `composite_shadow` so the original object stays in front and its AA
coverage still clips the shadow. Texture alpha, source-color mixing, and Fade
must not be applied twice. Scratch buffers must be initialized for every
frame before use, including after a no-shadow frame.

## Scope, cost, and fallback

Only Directional with Blur Shadow above zero uses the experimental two-layer
branch. All four quality levels share that branch. Directional Blur 0,
Radial, and Inverse Radial use their current paths. The second ray traversal
and blur chain will increase time and GPU memory; measure the difference at
Blur 40 on Standard and Ultra, and report it rather than treating quality as
the only acceptance condition. If performance is unacceptable or the visual
artifact remains, do not extend this method to other shadow types; retain the
verified baseline and reconsider the cause.

No track names, defaults, serialized values, or asset formats change. Existing
buffer-size and sample-count limits remain mandatory. Transparent source,
zero shadow length, invalid source position, and supersampling fallback must
continue to produce finite, current-frame output.

## Verification

Automated tests must first fail for the current implementation and then cover:

- a near/far ray with different distances retaining separate coverage and
  distance metadata;
- the unblurred recomposition matching the current maximum-coverage result,
  while opaque-front pixels retain raw rear data before blur;
- no hard transition at a global distance such as 0.5;
- Fade 50 and root subtraction working independently in both layers;
- Directional-only dispatch when Blur Shadow is positive, plus unchanged
  dispatch for Blur 0, Radial, and Inverse Radial;
- single application of Shadow Opacity, texture alpha, and final object
  occlusion, including Object Opacity 0%, 50%, and 100%;
- compilation of all embedded shaders and the full repository test suite.

Manual AviUtl2 comparison uses the reported text scene with Directional,
Fade 50, and Blur Shadow 40. Compare before and after at the circled glyph
holes and shadow roots, then check Blur 0, several blur strengths, all four
qualities, and Object Opacity 0/50/100%. Record the appearance and relative
render time. Automated tests alone cannot establish that the visible wedges
are fixed.

## Trial status (2026-09-24)

The Directional-only two-layer path is implemented on `master` through
`eabd4df`. All 42 automated tests pass, including embedded shader compilation.
The reported AviUtl2 scene is not present in this repository. An attempt to
inspect the running AviUtl2 window timed out awaiting app-operation approval,
so neither the visual result nor the Standard/Ultra performance cost has been
measured. Keep this as an unverified experiment until the user compares the
scene at Fade 50 and Blur Shadow 40; do not extend it to other shadow types
based on automated tests alone.
