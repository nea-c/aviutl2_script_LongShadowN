# Continuous Object and Shadow Compositing Design

## Goal

Preserve the source object's antialiasing where it overlaps the shadow, avoid
colored or dark fringes on either side of the source boundary, and make Object
Opacity remove the source-overlapping part of the shadow continuously rather
than through a binary mask.

When Object Opacity is zero, the source object and the shadow underneath its
coverage disappear, while the shadow that extends beyond the object remains.
The transition from the removed overlap to the extended shadow retains
antialiasing.

## Current Failure

`neutralize_shadow` converts source alpha into one-byte support with
`saturate(source.a * 255)`. Almost every nonzero antialiased source pixel
therefore becomes a full-strength mask. Where a shadow exists, that mask
replaces the shadow with an opaque object-colored backing. This avoids a dark
gap, but it necessarily makes the overlapping source edge look alpha-binary.

Earlier fixes also showed that removing all shadow beneath antialiased pixels
is not valid: doing so exposes the background as a fringe on the shadow-facing
edge. The compositor must retain continuous source coverage and distinguish
unextended distance-zero coverage from the shadow that actually extends away
from the object.

## Selected Approach

Use normal premultiplied source-over compositing and remove the binary backing
operation. Apply Object Opacity to overlapping shadow coverage with the
source's continuous alpha, while continuing to use Direct distance metadata to
discard distance-zero coverage outside the source.

The alternatives were rejected as follows:

- A separate root-coverage buffer would be more exact but adds a texture,
  memory traffic, and another contract to every quality tier.
- A dilated or supersampled source mask is heuristic and can reintroduce gaps
  or thickness changes as size, angle, and quality change.

## Compositing Model

Let `a` be the original source alpha and `o` be Object Opacity normalized to
0-1. Keep all colors premultiplied.

1. Remove only unextended root coverage outside the source. A styled shadow
   pixel is discarded when the original source alpha is zero and its Direct
   first-hit distance is zero. Positive-distance shadow remains untouched.
2. Attenuate shadow underneath the source by:

   `overlap_weight = 1 - a * (1 - o)`

   Multiply the premultiplied shadow RGBA by `overlap_weight`.
3. Apply Object Mix and Object Opacity to the source. Its output alpha remains
   `a * o`; Object Mix changes straight source color before repremultiplication.
4. Composite the styled source over the attenuated shadow with the standard
   premultiplied source-over operation.

This produces these endpoint behaviors:

- `o = 1`: the shadow is not artificially masked. Source AA blends naturally
  with the shadow behind it.
- `o = 0`: fully covered source pixels remove the overlapping shadow, partial
  source coverage attenuates it continuously, and positive-distance extension
  outside the source remains visible.
- transparent shadow: the source is rendered with its original continuous AA
  and no backing is synthesized.

The existing one-byte support calculation and object-colored backing are
removed. Object Mix affects the source contribution only. At antialiased
boundaries, the visible result may include the shadow behind the partially
covered source; that is intentional source-over behavior, not color dilution.

## Data Flow

The existing `cache:longshadown_resolved` texture remains the source of Direct
first-hit distance metadata for the final compositor. No new buffers or render
passes are added.

The final compositor receives:

- the styled shadow;
- the original source texture;
- resolved shadow metadata;
- Object Color, Mix, and Opacity.

It performs root-halo rejection, continuous overlap attenuation, source
styling, and source-over composition in that order. Fade, texture, Blur Shadow,
Post Smooth, and the Direct renderer remain unchanged.

## Behavior Matrix

| Source alpha | Object Opacity | Shadow distance | Result |
| ---: | ---: | ---: | --- |
| 0 | any | 0 | Discard unextended root coverage |
| 0 | any | greater than 0 | Keep extended shadow |
| between 0 and 1 | 1 | any | Continuous source-over-shadow AA |
| between 0 and 1 | 0 | any | Continuously attenuated shadow boundary |
| 1 | 0 | any | Remove shadow under the source |
| any | any | no shadow | Preserve source AA and Object controls |

## Compatibility

No user-facing parameter, default, saved-project value, quality tier, or
renderer routing changes. The change is limited to final compositing and its
tests. It must work identically for Directional, Radial, and Inverse Radial
because they share the resolved distance contract.

## Verification

Automated HLSL tests will verify:

- a half-covered source over an opaque differently colored shadow produces a
  continuous mixed edge rather than an object-colored binary edge;
- Object Opacity zero removes fully covered overlap, partially attenuates a
  half-covered boundary, and preserves positive-distance extension;
- a transparent shadow does not add backing or change source AA;
- distance-zero coverage outside the source is removed while positive-distance
  coverage is retained;
- Object Mix changes the source contribution without normalizing partial alpha
  back to opaque;
- every embedded shader compiles and the full regression suite passes.

Manual verification will compare Object Opacity at 100%, intermediate values,
and 0% using a high-contrast shadow. It will inspect the shadow-facing edge,
the edge opposite the extension direction, holes inside glyphs, and all three
shadow types. Acceptance requires no binary-looking source edge, no dark or
colored exterior fringe, a visibly antialiased boundary at Object Opacity 0,
and no loss of the positive-distance shadow extension.
