# Correlated Root and Extension Coverage Difference Design

## Goal

Remove the shadow-colored outline that can remain around the source silhouette
at any Object Opacity, quality, or shadow type. Preserve only shadow coverage
that actually protrudes beyond the source, with continuous antialiasing at the
new boundary.

The solution must work for Directional, Radial, and Inverse Radial in Draft,
Standard, High, and Ultra. It must not introduce a quality-specific distance
threshold or change the ray sample spacing.

## Root Cause

The Direct renderer currently derives two coverages at a pixel:

- `R`: coverage of the distance-zero source footprint;
- `E`: coverage reached by the shadow ray, including its positive-distance
  extension.

These values are correlated observations of the same antialiased silhouette,
not two independent translucent layers. Compositing them as independent layers
leaves a residual term:

`E * (1 - R)`

When an antialiased edge has `R = E = 0.5`, that expression leaves `0.25` of
colored shadow even though the shadow does not extend beyond the source there.
This is the visible outline. Object Opacity and quality settings change how
clearly it appears, but they do not cause it.

Distance thresholds cannot solve the general case. They can suppress one set
of samples while leaving the same correlated-coverage error at another scale,
quality, shadow direction, or curved edge.

## Selected Approach

Treat the shadow-only geometry as a correlated set difference, then express it
inside the source's uncovered fraction:

`D = saturate(E - R)`

`C = R < 1 ? D / (1 - R) : 0`

`D` is the coverage present in the extended shadow but absent from the source
footprint. `C` is the conditional shadow coverage used for filtering and
styling. The final compositor converts `C` back to the absolute contribution
`D`; this prevents normal source-over from attenuating `D` a second time.

This produces the required boundary behavior:

- equal root and extension coverage produces no shadow-only residue;
- extension coverage greater than root coverage preserves only the excess;
- extension coverage with no root coverage is preserved unchanged;
- root coverage greater than extension coverage produces no negative result.

The alternatives were rejected as follows:

- Dilating the source mask can hide a halo, but erodes gaps and fine details
  and introduces a scale-dependent radius.
- A distance threshold changes which ray samples contribute without fixing the
  correlated coverage equation.
- Independent source-over compositing is mathematically the source of the
  residual and therefore cannot be retained for the root/extension split.

No new user parameter or cache buffer is required.

## Coverage Resolution

Direct accumulation uses fuzzy-set union rather than repeated source-over:

`union(a, b) = max(a, b)`

This is required because adjacent ray samples often observe the same
antialiased silhouette coverage. Source-over would amplify repeated `0.5`
samples toward one and falsely turn them into new geometry.

Let `A_i` be one ray sample's coverage, `d_i` its normalized distance, and `R`
the source coverage at the exact distance-zero coordinate. Each sample forms:

`D_i = saturate(A_i - R)`

`C_i = R < 1 ? D_i / (1 - R) : 0`

`F_i = C_i * fade_weight(d_i)`

The ray stores `F = max(F_i)` and the source coordinate belonging to the
winning sample. Applying Fade after selecting the first hit is invalid: a
weak antialiased hit can then choose the Fade distance for stronger geometry
later on the ray, producing a step wherever that weak hit appears or disappears.

The distance for Blur Shadow and distance-based styling accumulates the newly
covered fraction at each sample: `W += d_i * (max(F, F_i) - F)` before updating
`F`. The resolved distance is `W / F`. Using only the winning sample's distance
can jump abruptly when two candidates exchange rank while their coverages stay
almost equal, creating sharp patches in an otherwise blurred shadow.

For 2x supersampling, this complete per-ray result is computed independently
for every raw work sample before the four results are averaged.

When `R` is effectively one, `D` is zero by definition. No hidden extension
needs to be reconstructed because set difference cannot exceed fully opaque
root coverage at that sample. The previous forced full-interior re-raymarch
for opaque roots is therefore removed, avoiding its performance cost.

The resolved metadata contract becomes:

- `r`: faded conditional shadow-only coverage `F`;
- `g`: accumulated coverage-weighted distance `W`;
- `b`: existing geometry flag;
- `a`: `F`, used to normalize the coverage-weighted distance.

`resolve_source_color` consumes the source coordinate selected by the winning
faded sample.

## Edge Refinement

`edge_antialias` must emit the same metadata contract as the Direct pass.
Every refined subpixel computes `F_i` for each ray sample and retains the
maximum together with its accumulated coverage-weighted distance.

The difference is computed per refined sample before averaging. Both the fast
non-edge path and the refined path therefore expose identical channel meanings
to styling and post-processing. Fully opaque roots no longer force refinement
when they are not otherwise edges.

No Ultra-specific minimum travel distance is used. Draft, Standard, High, and
Ultra retain their existing sampling patterns; only coverage interpretation is
changed.

## Styling and Final Compositing

`style_shadow` always consumes resolved red coverage `F`. Object Opacity does
not select between extension and total coverage, because restoring total
coverage would restore the source-shaped colored outline. Shadow color,
texture, Shadow Opacity, Post Smooth, and Blur Shadow all operate on `F`.

Post-processing can spread styled shadow back beneath the source footprint.
The final compositor converts conditional coverage back to the source's
uncovered fraction while compensating for the later source-over operation:

`visible_source_alpha = R * object_opacity`

`prepare_weight = (1 - R) / (1 - visible_source_alpha)`

The zero-denominator case returns no shadow. After normal premultiplied
source-over, the two factors cancel to `1 - R`, so styled conditional coverage
contributes exactly absolute coverage `D` at Object Opacity 0%, 50%, and 100%.
This also masks filter spill continuously without a binary cutout.

## Data Flow

1. `direct_raymarch_shadow` computes conditional coverage and Fade for every
   ray sample, retains the maximum `F`, and packs weighted distance plus the
   winning source coordinate.
2. `resolve_source_color` consumes the winning source coordinate.
3. `resolve_shadow` averages completed raw results for 2x supersampling and
   does not apply Fade again.
4. `edge_antialias` recomputes the same per-sample `F` contract.
5. `style_shadow` styles only `F`, independent of Object Opacity.
6. Existing smoothing and blur operate on the styled shadow-only result.
7. `composite_shadow` applies continuous overlap attenuation and normal
   premultiplied source-over.

Directional, Radial, and Inverse Radial share this path. Quality routing,
sample spacing, saved-project values, defaults, and cache-buffer count remain
unchanged.

## Behavior Matrix

| Root `R` | Extension `E` | Absolute `D` | Stored `C` | Result |
| ---: | ---: | ---: | ---: | --- |
| 0.5 | 0.5 | 0 | 0 | No correlated edge residue |
| 0.5 | 0.8 | 0.3 | 0.6 | Final contribution remains 0.3 |
| 0 | 0.4 | 0.4 | 0.4 | Preserve free-standing extension |
| 0.6 | 0.2 | 0 | 0 | Clamp non-protruding coverage |
| 1 | any | 0 | 0 | No forced opaque-root re-raymarch |

Object Opacity 0%, 50%, and 100% all use the same faded conditional coverage
and reconstruct the same
absolute `D`. The parameter changes the source contribution, never the
definition of shadow geometry.

## Verification

Automated tests will verify:

- a constant-foldable `shadow_only_coverage(E, R)` helper produces `0` for
  `(0.5, 0.5)`, `0.3` for `(0.8, 0.5)`, `0.4` for `(0.4, 0)`, and `0` for
  `(0.2, 0.6)`;
- `conditional_shadow_coverage(E, R)` produces `0.6` for `(0.8, 0.5)` and
  safely produces zero for a fully covered root;
- a weak near hit followed by a strong far hit produces the same faded coverage
  regardless of sample order;
- a near/far winner switch keeps the normalized distance continuous for Blur
  Shadow;
- `resolve_shadow` does not apply Fade a second time;
- 2x resolution computes `D` per raw work sample before averaging, using input
  values where averaging first would produce a different result;
- edge refinement uses the same per-sample difference contract;
- fully opaque roots do not force an otherwise unnecessary re-raymarch;
- `style_shadow` consumes `F` at Object Opacity 0%, 50%, and 100%;
- no Ultra-specific distance threshold remains;
- final composition reconstructs the same absolute `D` at Object Opacity 0%,
  50%, and 100%;
- all embedded shaders compile and the full regression suite passes.

Manual verification will compare Object Opacity 0%, 50%, and 100% for every
shadow type and quality, with Supersampling None and 2x. Tests will use both
white and black source colors so a colored outline cannot hide in the source.
They will inspect extension-facing and opposite edges, curved glyphs,
one-pixel details, glyph holes, and converged radial geometry. Blur Shadow zero
and a representative nonzero blur are both checked.

Acceptance requires no colored exterior outline, no binary source edge, no
root gap, no loss of real protruding shadow, and no opaque-interior performance
regression.
