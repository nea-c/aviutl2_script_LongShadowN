# Continuous Object and Shadow Compositing Design

## Goal

Preserve source antialiasing where it overlaps the shadow, remove the colored
distance-zero outline around a hidden object, and retain only the shadow that
actually extends away from the object when Object Opacity is zero.

At Object Opacity zero, the source and shadow beneath its coverage disappear.
The positive-distance extension remains, including inside glyph holes, and the
cutout boundary retains continuous antialiasing. Object Opacity 100 keeps the
current full shadow and normal premultiplied source-over appearance.

## Root Cause

The Direct renderer currently stores one union coverage value containing both
the distance-zero source footprint and all positive-distance ray samples. The
final compositor sees only that combined value. First-hit distance cannot
separate the two: a pixel may hit a partially transparent root at distance zero
and later accumulate real positive-distance coverage.

The previous final-only fix therefore had two incompatible outcomes:

- retaining combined coverage leaves a thin shadow-colored copy of the source
  boundary when Object Opacity is zero;
- rejecting every zero-first-hit pixel can also delete real extension inside
  transparent glyph holes.

The distinction must be recovered before styling and post-processing, where
the original Direct coverage and source texture are both available.

## Selected Approach

During `resolve_shadow`, resample the source at each Direct work sample's exact
distance-zero coordinate and reconstruct positive-distance extension coverage
from the combined coverage. Store resolved extension coverage in the otherwise
unused red channel while retaining total coverage in alpha.

The alternatives were rejected as follows:

- A dedicated extension buffer is the clearest representation, but adds a
  buffer, another pass or render target, and extra memory traffic.
- Dropping the distance-zero Direct sample is smaller, but the next ray sample
  can be 4 source pixels away in Draft quality and create a root gap.
- First-hit distance alone is insufficient because zero and positive-distance
  contributions can coexist in one pixel.

No new cache buffer is added. Pixels whose distance-zero source sample is
fully opaque are conditionally re-raymarched by the existing edge-refinement
pass, because their positive-distance contribution cannot be recovered from
combined coverage.

## Coverage Reconstruction

For each Direct work sample, let:

- `T` be the existing combined union coverage;
- `R` be the source alpha resampled at that work sample's distance-zero pixel;
- `E` be the union coverage contributed by positive-distance samples.

Direct accumulation obeys:

`T = R + (1 - R) * E`

Therefore resolve reconstructs:

`E = saturate((T - R) / max(1 - R, epsilon))`

When `R` is effectively one, `E` is not observable from `T`. Storing zero is
not safe: reducing Object Opacity exposes that extension, and Blur Shadow can
spread it beyond the opaque root. Such pixels therefore enter edge refinement,
which accumulates positive-distance samples independently from total coverage.

For 2x supersampling, reconstruction occurs independently for all four raw
work samples before averaging. Averaging `T` and `R` first would not preserve
the nonlinear union equation. Fade weight is then applied consistently to
both total and extension coverage.

The resolved metadata contract becomes:

- `r`: faded positive-distance extension coverage;
- `g`: existing faded distance-weighted total coverage;
- `b`: existing geometry flag;
- `a`: faded total coverage.

`resolve_source_color` continues reading the raw Direct texture before this
contract is created, so its encoded source coordinates remain unchanged.

## Edge Refinement

`edge_antialias` must emit the same resolved contract. For every refined
subpixel it recomputes total Direct coverage from the source and independently
accumulates samples whose normalized distance is greater than zero. It applies
fade and stores that extension in the red channel.

The fast non-edge path returns the resolved center unchanged unless the root is
fully opaque. Opaque roots force refinement even away from geometric edges so
hidden positive-distance coverage survives styling and blur. Both paths thus
provide identical channel meanings to styling, blur metadata, and final
compositing.

## Styling and Compositing

Shadow styling always uses positive-distance extension coverage:

`C = E`

Distance-zero coverage is never restored by Object Opacity. Restoring `T`
allows the root silhouette to show through the source's antialiased boundary,
creating a colored outline even when Object Opacity is 100%. `style_shadow`
uses `E * ShadowOpacity` as its premultiplied alpha before Post Smooth or Blur
Shadow.

Ultra's first positive sample is closer than High's and can reproduce the
source AA footprint. Edge refinement therefore excludes Ultra samples below a
High-equivalent travel distance: 0.75 px at Native scale and 0.375 px at 2x.
Later Ultra samples retain their 0.5 px sampling density.

The final compositor then uses the original source alpha `a` to cut extension
from beneath the fading object:

`overlap_weight = 1 - a * (1 - o)`

It multiplies the premultiplied styled shadow by this weight, applies Object
Mix and Object Opacity to the source, and performs standard premultiplied
source-over. The old first-hit-distance rejection is removed; the explicit
extension channel supersedes it.

## Data Flow

1. `direct_raymarch_shadow` continues producing its existing raw packed data.
2. `resolve_source_color` consumes that raw data unchanged.
3. `resolve_shadow` receives the raw data plus the original source texture and
   source bounds, reconstructing total and extension coverage per work sample.
4. `edge_antialias` preserves or recomputes the new resolved contract.
5. `style_shadow` styles only positive-distance extension coverage `E`.
6. Existing smoothing and blur operate on that styled result.
7. `composite_shadow` applies continuous source-overlap attenuation and normal
   premultiplied source-over.

Directional, Radial, and Inverse Radial share this path. No quality routing,
user parameter, default, saved-project value, or cache-buffer count changes.

## Behavior Matrix

| Root coverage | Extension coverage | Object Opacity | Result |
| ---: | ---: | ---: | --- |
| greater than 0 | 0 | 0 | No colored root outline |
| 0 | greater than 0 | 0 | Preserve extended shadow |
| greater than 0 | greater than 0 | 0 | Preserve extension, cut it by continuous source alpha |
| any | any | between 0 and 1 | Keep extension-only shadow and continuously restore the source contribution |
| any | any | 1 | Keep extension-only shadow and normal source-over |
| 1 | unobservable | 0 | Fully suppressed by the opaque source cutout |

## Verification

Automated tests will verify:

- extension reconstruction returns zero for root-only coverage and recovers a
  known positive extension from combined coverage;
- 2x supersampling reconstructs each work sample before averaging;
- a transparent center surrounded by source samples retains positive-distance
  extension rather than being rejected by first-hit distance;
- `style_shadow` selects extension coverage at Object Opacity zero, 50%, and
  100%, never restoring distance-zero coverage;
- Ultra excludes its sub-High first sample from extension coverage at Native
  and 2x scales while High remains unchanged;
- final overlap attenuation remains continuous for fractional source alpha;
- the old first-hit rejection is absent;
- all embedded shaders compile and the full regression suite passes.

Manual verification will compare Object Opacity at 0%, 50%, and 100% for
Directional, Radial, and Inverse Radial, with Supersampling None and 2x. It
will inspect the extension-facing edge, the opposite edge, curved glyphs,
one-pixel details, and glyph holes. Acceptance requires no colored exterior
outline, no root gap, no binary source edge, and no loss of positive-distance
extension. Blur Shadow zero and a representative nonzero blur are both checked.
