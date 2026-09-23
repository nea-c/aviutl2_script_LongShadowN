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

Let `T` be the maximum coverage across all ray samples and `R` the source
coverage at the exact distance-zero coordinate. The absolute and stored
conditional shadow coverages are:

`D = saturate(T - R)`

`C = R < 1 ? D / (1 - R) : 0`

For 2x supersampling, `R`, `E`, `D`, and `C` are resolved independently for every
raw work sample before the four results are averaged. Computing the difference
after averaging loses the nonlinear set relationship and can recreate a halo.

When `R` is effectively one, `D` is zero by definition. No hidden extension
needs to be reconstructed because set difference cannot exceed fully opaque
root coverage at that sample. The previous forced full-interior re-raymarch
for opaque roots is therefore removed, avoiding its performance cost.

Fade is applied consistently after `C` is formed. The resolved metadata
contract becomes:

- `r`: faded conditional shadow-only coverage `C`;
- `g`: existing faded distance-weighted total coverage;
- `b`: existing geometry flag;
- `a`: faded total coverage `T`.

`resolve_source_color` continues consuming the raw Direct texture before this
contract is produced, so its encoded source-coordinate behavior is unchanged.

## Edge Refinement

`edge_antialias` must emit the same metadata contract as `resolve_shadow`.
Every refined subpixel accumulates positive-distance coverage `E` with `max`,
samples its matching root coverage `R`, computes `D = saturate(E - R)`, and
stores `C = D / (1 - R)` when `R < 1`.

The difference is computed per refined sample before averaging. Both the fast
non-edge path and the refined path therefore expose identical channel meanings
to styling and post-processing. Fully opaque roots no longer force refinement
when they are not otherwise edges.

No Ultra-specific minimum travel distance is used. Draft, Standard, High, and
Ultra retain their existing sampling patterns; only coverage interpretation is
changed.

## Styling and Final Compositing

`style_shadow` always consumes resolved red coverage `C`. Object Opacity does
not select between extension and total coverage, because restoring total
coverage would restore the source-shaped colored outline. Shadow color,
texture, Shadow Opacity, Post Smooth, and Blur Shadow all operate on `C`.

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

1. `direct_raymarch_shadow` produces its existing raw packed data.
2. `resolve_source_color` consumes the raw source-coordinate data unchanged.
3. `resolve_shadow` obtains `R`, computes per-sample `D = saturate(T - R)` and
   `C = D / (1 - R)`, and writes the new resolved metadata contract.
4. `edge_antialias` preserves or recomputes the same per-sample `C` contract.
5. `style_shadow` styles only `C`, independent of Object Opacity.
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

Object Opacity 0%, 50%, and 100% all use the same `C` and reconstruct the same
absolute `D`. The parameter changes the source contribution, never the
definition of shadow geometry.

## Verification

Automated tests will verify:

- a constant-foldable `shadow_only_coverage(E, R)` helper produces `0` for
  `(0.5, 0.5)`, `0.3` for `(0.8, 0.5)`, `0.4` for `(0.4, 0)`, and `0` for
  `(0.2, 0.6)`;
- `conditional_shadow_coverage(E, R)` produces `0.6` for `(0.8, 0.5)` and
  safely produces zero for a fully covered root;
- 2x resolution computes `D` per raw work sample before averaging, using input
  values where averaging first would produce a different result;
- edge refinement uses the same per-sample difference contract;
- fully opaque roots do not force an otherwise unnecessary re-raymarch;
- `style_shadow` consumes `C` at Object Opacity 0%, 50%, and 100%;
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
