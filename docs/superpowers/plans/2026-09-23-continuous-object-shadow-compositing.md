# Correlated Coverage Difference Implementation Plan

> Implementation correction: resolved red now stores conditional coverage
> `C = saturate(T - R) / (1 - R)` for `R < 1`, and final composition restores
> the absolute difference with `(1 - R) / (1 - R * object_opacity)`. This
> supersedes the earlier `r = D` and overlap-weight details below; see the
> companion design document for the current contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the colored source-outline artifact by styling only the per-sample correlated coverage difference `D = saturate(E - R)`.

**Architecture:** Keep the existing Direct raymarch and source-coordinate packing, but accumulate ray coverage as fuzzy-set union with `max` so repeated samples of one antialiased edge are not amplified. Compute shadow-only difference coverage independently in `resolve_shadow` and `edge_antialias`, store it in resolved `.r`, then make `style_shadow` consume `.r` regardless of Object Opacity. Retain continuous final overlap attenuation for shadow spread introduced by smoothing or blur.

**Tech Stack:** AviUtl2 `.anm2` Lua script, embedded HLSL Shader Model 5 pixel shaders, Node.js `node:test`, Microsoft FXC.

**Spec:** `docs/superpowers/specs/2026-09-23-continuous-object-shadow-compositing-design.md`

## Global Constraints

- Do not add a render pass, cache buffer, user-facing parameter, or saved-project value.
- Keep Directional, Radial, and Inverse Radial routing and Draft/Standard/High/Ultra sample spacing unchanged.
- Keep the raw Direct source-coordinate packing consumed by `resolve_source_color` unchanged.
- Compute `D = saturate(E - R)` for each raw or refined sample before averaging.
- Store faded `D` in resolved `.r`; preserve the existing meanings of resolved `.g`, `.b`, and `.a`.
- Do not add or retain an Ultra-specific minimum-distance threshold.
- Do not force non-edge opaque-root pixels through the expensive refined raymarch.
- Make Post Smooth and Blur Shadow operate on shadow styled from `D` only.
- Keep premultiplied RGBA and the existing continuous final overlap attenuation.

## Review Focus

- Equal fractional root and extension coverage, especially `R = E = 0.5`, must produce exactly zero styled shadow; Task 1 tests all four behavior-matrix cases.
- Mixed 2x samples where difference-before-average and difference-after-average disagree must follow the former; Task 1 uses `(E,R) = (0.1,0.9)` and `(0.9,0.1)`.
- Refined curved edges and glyph holes must use the same difference contract as the center resolve path; Task 2 pins root sampling, subtraction, and contribution order.
- Fully opaque interior pixels must take the fast return without losing any possible `D`; Task 2 removes and structurally rejects forced opaque-root refinement.
- Object Opacity 0%, 50%, and 100% must not alter shadow geometry before filtering; Task 3 compiles all three cases and rejects style-shader opacity wiring.

---

## Final Review Correction

The initial Task 1 reconstruction assumed source-over union,
`T = R + (1 - R) * E`. Final review demonstrated that repeated equal-alpha
samples from one non-extending edge make that model amplify coverage and leave
a residual outline. The implementation therefore supersedes the original
Task 1 accumulation/reconstruction steps with these requirements:

- Direct total coverage is `max` across ray samples;
- refined total and positive-distance extension coverage are each `max` across
  their applicable samples;
- resolve computes `D = saturate(T - R)` directly for every raw sample;
- repeated `0.5` root/ray samples produce `D = 0`, while a later `0.8` sample
  against a `0.5` root produces `D = 0.3`;
- both shader-scoped `shadow_only_coverage` definitions are numerically tested.

The remaining task steps and final-compositing contract are unchanged.

---

### Task 1: Resolve correlated shadow-only coverage per raw sample

**Files:**
- Modify: `LongShadowN.anm2:691-755` — shared coverage math and `resolve_shadow`.
- Modify: `tests/composite-shadow.test.mjs:613-662` — constant-folding and 2x ordering tests.

**Interfaces:**
- Consumes: `float reconstruct_extension_coverage(float total_coverage, float root_coverage)`, total union coverage `T`, and root coverage `R` sampled at the matching raw coordinate.
- Produces: `float shadow_only_coverage(float extension_coverage, float root_coverage)` and resolved `.r = D * fade_weight`.
- Preserves: resolved `.g = distance-weighted total * fade`, `.b = geometry`, `.a = total * fade`, and the Lua/HLSL constant-buffer padding contract.

- [ ] **Step 1: Replace the extension-only expectations with failing difference tests**

Replace `extension coverage separates root from ray accumulation` with:

```js
test("correlated coverage difference removes only the shared root", () => {
  const source = readFileSync(scriptPath, "utf8");
  const difference = extractFunction(source, "shadow_only_coverage", "float");
  const assembly = compileConstantResult(`
${difference}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    bool correct = abs(shadow_only_coverage(0.5, 0.5) - 0.0) < 1e-6
        && abs(shadow_only_coverage(0.8, 0.5) - 0.3) < 1e-6
        && abs(shadow_only_coverage(0.4, 0.0) - 0.4) < 1e-6
        && abs(shadow_only_coverage(0.2, 0.6) - 0.0) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "correlated root coverage survived as a colored shadow outline");
});
```

Replace `resolved extension is reconstructed before 2x averaging` with both a
numeric ordering check and a structural shader check:

```js
test("shadow-only coverage is differenced before 2x averaging", () => {
  const source = readFileSync(scriptPath, "utf8");
  const difference = extractFunction(source, "shadow_only_coverage", "float");
  const assembly = compileConstantResult(`
${difference}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float per_sample = (shadow_only_coverage(0.1, 0.9)
        + shadow_only_coverage(0.9, 0.1)) * 0.5;
    float after_average = shadow_only_coverage(0.5, 0.5);
    bool correct = abs(per_sample - 0.4) < 1e-6
        && abs(after_average) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/);

  const shader = source.match(
    /--\[\[pixelshader@resolve_shadow:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "resolve_shadow shader was not found");
  const perSampleDifference = shader.search(
    /shadow_only_coverage\(\s*extension_coverage,\s*root_alpha\)/);
  const averaging = shader.indexOf("shadow_only /= 4");
  assert.ok(perSampleDifference >= 0 && averaging > perSampleDifference,
    "2x resolve averaged correlated coverages before subtraction");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="correlated coverage difference|differenced before 2x" tests/composite-shadow.test.mjs
```

Expected: FAIL because `shadow_only_coverage` is not defined.

- [ ] **Step 3: Add the shared difference helper to `resolve_shadow`**

Immediately after `reconstruct_extension_coverage`, add:

```hlsl
float shadow_only_coverage(float extension_coverage,
    float root_coverage) {
    return saturate(extension_coverage - saturate(root_coverage));
}
```

Keep `reconstruct_extension_coverage` unchanged. It still derives `E` from
`T` and `R`; the new helper converts `E` and `R` into `D`.

- [ ] **Step 4: Compute and average `D` inside the raw-sample loop**

In `resolve_shadow`, replace the `extension_coverage` accumulator with
`shadow_only`. In the 2x loop, reconstruct and subtract before adding:

```hlsl
float shadow_only = 0;
// ...inside the existing 2x loop...
float root_alpha = sample_root_alpha(pixel);
float extension_coverage = reconstruct_extension_coverage(
    sample_info.a, root_alpha);
shadow_only += shadow_only_coverage(extension_coverage, root_alpha);
shadow_info += sample_info;
```

After the loop, average both accumulators:

```hlsl
shadow_info /= 4;
shadow_only /= 4;
```

In the native branch, use the same order:

```hlsl
float root_alpha = sample_root_alpha(pos.xy / work_scale);
float extension_coverage = reconstruct_extension_coverage(
    shadow_info.a, root_alpha);
shadow_only = shadow_only_coverage(extension_coverage, root_alpha);
```

Return `shadow_only` in resolved red:

```hlsl
return float4(shadow_only * weight, shadow_info.g * weight,
    geometry, shadow_info.a * weight);
```

- [ ] **Step 5: Run Task 1 tests and shader compilation**

Run:

```powershell
node --test --test-name-pattern="correlated coverage difference|differenced before 2x|resolve shadow constants|all embedded pixel shaders compile" tests/composite-shadow.test.mjs
```

Expected: all selected tests PASS; every embedded shader compiles.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Compute correlated shadow coverage per sample"
```

---

### Task 2: Apply the same contract to refined edges

**Files:**
- Modify: `LongShadowN.anm2:289-307` — edge shader coverage helpers.
- Modify: `LongShadowN.anm2:416-527` — refinement routing and contribution.
- Modify: `tests/composite-shadow.test.mjs:664-702` — refined-edge and opaque-root tests.

**Interfaces:**
- Consumes: independently accumulated refined extension coverage `E`, the refined subpixel root sample `R`, and `shadow_only_coverage(E, R)`.
- Produces: each refined contribution as `{ D * weight, first_distance * total * weight, geometry, total * weight }`.
- Removes: `opaque_root_requires_refine` and its forced full-interior raymarch.

- [ ] **Step 1: Write failing refined-contract tests**

Replace `edge refinement emits extension coverage in resolved red` with:

```js
test("edge refinement emits correlated difference coverage in resolved red", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@edge_antialias:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "edge_antialias shader was not found");
  assert.match(shader,
    /float root_alpha\s*=\s*sample_source_alpha\(pixel\)/,
    "refinement did not sample root coverage at the refined subpixel");
  assert.match(shader,
    /float shadow_only\s*=\s*shadow_only_coverage\(\s*extension_coverage,\s*root_alpha\s*\)/,
    "refinement did not subtract correlated root coverage");
  assert.match(shader,
    /float4 contribution\s*=\s*float4\(shadow_only \* weight,/);
});
```

Replace `opaque roots force independent positive-distance refinement` with:

```js
test("opaque non-edge roots keep the fast path", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@edge_antialias:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "edge_antialias shader was not found");
  assert.doesNotMatch(shader, /opaque_root_requires_refine/);
  assert.match(shader,
    /if \(!geometry_edge && !fade_edge\) return center;/,
    "non-edge opaque roots still enter the expensive refined raymarch");
});
```

- [ ] **Step 2: Run Task 2 tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="edge refinement emits correlated|opaque non-edge roots" tests/composite-shadow.test.mjs
```

Expected: FAIL because the edge shader still emits raw extension coverage and
contains `opaque_root_requires_refine`.

- [ ] **Step 3: Add the difference helper and remove forced opaque refinement**

Add the same helper after the edge shader's reconstruction helper:

```hlsl
float shadow_only_coverage(float extension_coverage,
    float root_coverage) {
    return saturate(extension_coverage - saturate(root_coverage));
}
```

Delete the `opaque_root_requires_refine` calculation and its explanatory
comment. Restore the fast-return condition to:

```hlsl
if (!geometry_edge && !fade_edge) return center;
```

- [ ] **Step 4: Difference each refined sample before averaging**

Immediately after the refined pixel coordinate is created, sample its root:

```hlsl
float2 pixel = pos.xy + refine_offset(i);
float root_alpha = sample_source_alpha(pixel);
```

Keep independent positive-distance accumulation in
`accumulate_shadow_coverages`. After its ray loop, compute `D` and emit it:

```hlsl
float shadow_only = shadow_only_coverage(
    extension_coverage, root_alpha);
float weight = fade_weight_aa(first_distance);
float weighted_coverage = coverage * weight;
float4 contribution = float4(shadow_only * weight,
    first_distance * weighted_coverage,
    found_source ? 1 : 0, weighted_coverage);
```

Because `refined` is divided only after each contribution is formed, this
preserves difference-before-average ordering.

- [ ] **Step 5: Add a regression assertion that no quality threshold exists**

Add:

```js
test("coverage difference does not alter quality sample spacing", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /extension_sample_alpha|minimum_travel/);
});
```

The existing `Direct quality spacing remains 4 2 1 and 0.5 source pixels`
test continues to pin the exact `get_quality_config` table.

- [ ] **Step 6: Run Task 2 tests and shader compilation**

Run:

```powershell
node --test --test-name-pattern="edge refinement emits correlated|opaque non-edge roots|coverage difference does not alter|Direct quality spacing|all embedded pixel shaders compile" tests/composite-shadow.test.mjs
```

Expected: all selected tests PASS; Draft/Standard/High/Ultra remain `4/2/1/0.5` source pixels.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Use correlated coverage on refined edges"
```

---

### Task 3: Decouple styled shadow geometry from Object Opacity

**Files:**
- Modify: `LongShadowN.anm2:591-662` — style constants and coverage selection.
- Modify: `LongShadowN.anm2:1173-1194` — Lua style-shader constants.
- Modify: `tests/composite-shadow.test.mjs:704-737` — opacity-independent styling tests.
- Verify: `LongShadowN.anm2:880-909` — final continuous overlap compositor remains unchanged.

**Interfaces:**
- Consumes: resolved `.r = D * fade_weight`.
- Produces: `float select_shadow_coverage(float4 shadow_info)` returning only `.r`, independent of Object Opacity.
- Preserves: `prepare_shadow_for_object(float4 shadow, float4 source)` and premultiplied source-over.

- [ ] **Step 1: Replace opacity-interpolation tests with failing invariant tests**

Replace `Object Opacity selects extension before shadow styling` with:

```js
test("Object Opacity never changes pre-filter shadow geometry", () => {
  const source = readFileSync(scriptPath, "utf8");
  const selectCoverage = extractFunction(
    source, "select_shadow_coverage", "float");
  for (const opacity of ["0", "0.5", "1"]) {
    const assembly = compileConstantResult(`
static const float object_opacity = ${opacity};
${selectCoverage}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float result = select_shadow_coverage(float4(0.3, 0.2, 1, 0.9));
    bool correct = abs(result - 0.3) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      `Object Opacity ${opacity}`);
  }
});
```

Replace `style shadow receives normalized Object Opacity before filtering` with:

```js
test("style shadow has no Object Opacity input", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@style_shadow:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "style_shadow shader was not found");
  assert.doesNotMatch(shader, /float object_opacity/);
  const calls = [...source.matchAll(
    /obj\.pixelshader\("style_shadow"[\s\S]*?shadow_mix \/ 100, shadow_type, target_scale([^}]*)\}, "copy", "(?:loop|clamp)"\)/g,
  )];
  assert.equal(calls.length, 2);
  for (const call of calls) assert.doesNotMatch(call[1], /object_opacity/);
});
```

- [ ] **Step 2: Run Task 3 tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="never changes pre-filter|has no Object Opacity input" tests/composite-shadow.test.mjs
```

Expected: FAIL because style coverage still interpolates `.r` and `.a`, and
the style shader still receives Object Opacity.

- [ ] **Step 3: Make style coverage use only resolved red**

Remove `float object_opacity;` from the end of the `style_shadow` constant
buffer and change the selector to:

```hlsl
float select_shadow_coverage(float4 shadow_info) {
    return shadow_info.r;
}
```

Keep the existing premultiplied style calculation:

```hlsl
float solid_alpha = select_shadow_coverage(shadow_info) * shadow_opacity;
```

Remove `object_opacity / 100` from both Lua `style_shadow` constant arrays so
`target_scale` is the final constant.

- [ ] **Step 4: Run focused compositing and shader tests**

Run:

```powershell
node --test --test-name-pattern="never changes pre-filter|has no Object Opacity input|full composition keeps|continuous source antialiasing|Object Opacity attenuates|Object Mix|all embedded pixel shaders compile" tests/composite-shadow.test.mjs
```

Expected: all selected tests PASS. Existing final-overlap tests remain green,
showing that blur spill is still attenuated continuously.

- [ ] **Step 5: Run the complete automated suite and inspect scope**

Run:

```powershell
node --test tests/*.test.mjs
git diff --check
rg -n "shadow_only_coverage|opaque_root_requires_refine|extension_sample_alpha|minimum_travel|select_shadow_coverage|object_opacity" LongShadowN.anm2 tests/composite-shadow.test.mjs
git diff -- LongShadowN.anm2 tests/composite-shadow.test.mjs
```

Expected:

- the complete suite passes and every embedded shader compiles;
- `shadow_only_coverage` appears in both resolve and edge-refinement shaders;
- `opaque_root_requires_refine`, `extension_sample_alpha`, and `minimum_travel` are absent;
- Object Opacity appears only in final object/overlap composition, not in `style_shadow`;
- no renderer routing, cache-buffer allocation, user parameter, or Direct packing changed;
- `git diff --check` reports no errors.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Style only correlated shadow coverage"
```

- [ ] **Step 7: Perform the manual AviUtl acceptance matrix**

Use the saturated rainbow shadow and antialiased `LongShadowN` text from the
reported reproducer. Test both white and black source colors.

For Directional, Radial, and Inverse Radial, check all of:

- quality: Draft, Standard, High, Ultra;
- Object Opacity: `0`, `50`, `100`;
- Supersampling: `None`, `2x`;
- Blur Shadow: `0`, plus one clearly visible nonzero value.

Inspect extension-facing edges, non-extending outer edges, curved glyphs,
glyph holes, one-pixel details, and converged Radial/Inverse Radial geometry.

Acceptance requires:

- no colored exterior outline at any Object Opacity;
- no binary or darkened source AA boundary;
- no root gap and no loss of genuine protruding shadow;
- no convergence discontinuity introduced by the change;
- no opaque-interior slowdown relative to the pre-`r9` behavior.
