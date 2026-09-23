# Root and Extension Coverage Compositing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the colored distance-zero outline at Object Opacity zero while retaining antialiased positive-distance shadow extension, including inside glyph holes.

**Architecture:** Resolve total Direct coverage and reconstructed positive-distance extension coverage into separate channels of the existing metadata texture. Select between extension and total coverage before styling and blur according to Object Opacity, then apply the original source alpha only as a continuous final overlap cutout.

**Tech Stack:** AviUtl2 `.anm2` Lua script, embedded HLSL pixel shaders, Node.js `node:test`, Microsoft FXC Shader Model 5 compiler.

**Spec:** `docs/superpowers/specs/2026-09-23-continuous-object-shadow-compositing-design.md`

## Global Constraints

- Do not add a render pass, cache buffer, user-facing parameter, or saved-project value.
- Keep Directional, Radial, and Inverse Radial renderer and quality routing unchanged.
- Keep Direct raw source-coordinate packing consumed by `resolve_source_color` unchanged.
- Reconstruct 2x supersampling extension coverage per raw work sample before averaging.
- Store faded positive-distance extension coverage in resolved `.r` and faded total coverage in resolved `.a`.
- Select extension-versus-total coverage before Post Smooth and Blur Shadow.
- Keep premultiplied RGBA through styling and final source-over.
- Remove final first-hit-distance rejection; an explicit extension channel replaces it.

## Review Focus

- A root-only antialiased pixel must reconstruct zero extension instead of producing an exterior colored outline; Task 1 Step 1 includes `T = R = 0.4375`.
- A zero-first-hit pixel with later ray coverage must retain extension; Task 1 Step 1 includes `R = 0.4375`, `E = 0.8`, and `T = 0.8875`.
- 2x supersampling must reconstruct each of four nonlinear samples before averaging; Task 1 Step 1 checks operation ordering inside `resolve_shadow`.
- Object Opacity 0, 50, and 100 must select extension, midpoint, and total coverage before blur; Task 2 Step 1 compiles all three endpoints.
- Fractional source alpha and partially transparent shadow must remain proportional after the final overlap cutout; Task 2 Step 1 compiles full composition at opacity 0 and 0.5.

---

### Task 1: Resolve positive-distance extension coverage

**Files:**
- Modify: `LongShadowN.anm2:255-510` — edge refinement contract.
- Modify: `LongShadowN.anm2:667-700` — resolved metadata reconstruction.
- Modify: `LongShadowN.anm2:1103-1114` — resolve shader inputs and constants.
- Modify: `tests/composite-shadow.test.mjs:48-612` — reconstruction and protocol tests.

**Interfaces:**
- Consumes: raw Direct `float4` where `.a` is total union coverage, the original source texture, `source_offset`, `source_size`, and `work_scale`.
- Produces: `float reconstruct_extension_coverage(float total_coverage, float root_coverage)` and resolved metadata `{ extension * fade, distance * total * fade, geometry, total * fade }`.
- Preserves: raw `.rb` source-coordinate encoding before resolve and the existing resolved `.g`, `.b`, and `.a` meanings.

- [ ] **Step 1: Add failing extension-reconstruction and resolved-contract tests**

Add this constant-folded HLSL test to `tests/composite-shadow.test.mjs`:

```js
test("extension coverage separates root from ray accumulation", () => {
  const source = readFileSync(scriptPath, "utf8");
  const reconstruct = extractFunction(source, "reconstruct_extension_coverage");
  const assembly = compileConstantResult(`
${reconstruct}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float root = 0.4375;
    float expected_extension = 0.8;
    float combined = root + (1 - root) * expected_extension;
    bool correct = abs(reconstruct_extension_coverage(root, root)) < 1e-6
        && abs(reconstruct_extension_coverage(combined, root)
            - expected_extension) < 1e-6
        && abs(reconstruct_extension_coverage(0.6, 0) - 0.6) < 1e-6
        && abs(reconstruct_extension_coverage(1, 1)) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "root-only coverage or positive-distance extension was reconstructed incorrectly");
});
```

Add a structural test that pins per-work-sample reconstruction and the Lua
input contract:

```js
test("resolved extension is reconstructed before 2x averaging", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@resolve_shadow:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "resolve_shadow shader was not found");
  const sampleReconstruction = shader.indexOf(
    "reconstruct_extension_coverage(sample_info.a, root_alpha)");
  const averaging = shader.indexOf("shadow_info /= 4");
  assert.ok(sampleReconstruction >= 0 && averaging > sampleReconstruction,
    "2x resolve averaged nonlinear coverage before reconstruction");
  assert.match(shader, /Texture2D source_texture\s*:\s*register\(t1\)/);
  assert.match(source,
    /obj\.pixelshader\("resolve_shadow"[\s\S]*?\{\s*"cache:longshadown_shadow_a",\s*"cache:longshadown_source"\s*\}/);
});
```

Add a protocol test for refined edges:

```js
test("edge refinement emits extension coverage in resolved red", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@edge_antialias:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "edge_antialias shader was not found");
  assert.match(shader,
    /float extension_coverage\s*=\s*reconstruct_extension_coverage\(coverage,\s*root_alpha\)/);
  assert.match(shader,
    /float4 contribution\s*=\s*float4\(extension_coverage \* weight,/);
});
```

- [ ] **Step 2: Run Task 1 tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="extension coverage separates|resolved extension is reconstructed|edge refinement emits" tests/composite-shadow.test.mjs
```

Expected: FAIL because `reconstruct_extension_coverage was not found` and the
resolve shader still accepts only the raw shadow texture.

- [ ] **Step 3: Add shared reconstruction math and root sampling to both shaders**

Add this helper inside both `edge_antialias` and `resolve_shadow` shader blocks:

```hlsl
float reconstruct_extension_coverage(float total_coverage,
    float root_coverage) {
    float uncovered_root = 1 - saturate(root_coverage);
    if (uncovered_root <= 1e-6) return 0;
    return saturate((total_coverage - root_coverage) / uncovered_root);
}
```

In `resolve_shadow`, add the original source as `t1`, a linear sampler, source
bounds in the constant buffer, and exact Direct-coordinate root sampling:

```hlsl
Texture2D source_texture : register(t1);
SamplerState linear_sampler : register(s0);
float sample_root_alpha(float2 pixel) {
    float2 local = pixel - source_offset;
    if (any(local < 0) || any(local >= source_size)) return 0;
    return saturate(source_texture.SampleLevel(
        linear_sampler, local / source_size, 0).a);
}
```

Extend the `resolve_shadow` constant buffer with `float2 source_offset` and
`float2 source_size` after `work_scale`.

- [ ] **Step 4: Reconstruct each raw work sample before averaging**

Replace the resolve accumulation with explicit per-sample extension
reconstruction. In the 2x branch, use the raw work-pixel center that the Direct
shader used:

```hlsl
float extension_coverage = 0;
if (work_scale >= 1.5) {
    int2 base = int2(pos.xy) * 2;
    shadow_info = 0;
    [unroll]
    for (int y = 0; y < 2; ++y) {
        [unroll]
        for (int x = 0; x < 2; ++x) {
            int2 work_position = base + int2(x, y);
            float4 sample_info = shadow_texture[work_position];
            float2 pixel = (float2(work_position) + 0.5) / work_scale;
            float root_alpha = sample_root_alpha(pixel);
            extension_coverage += reconstruct_extension_coverage(
                sample_info.a, root_alpha);
            shadow_info += sample_info;
        }
    }
    shadow_info /= 4;
    extension_coverage /= 4;
} else {
    shadow_info = shadow_texture[int2(pos.xy)];
    float root_alpha = sample_root_alpha(pos.xy / work_scale);
    extension_coverage = reconstruct_extension_coverage(
        shadow_info.a, root_alpha);
}
```

Keep the existing distance, fade, and geometry calculations, but return:

```hlsl
return float4(extension_coverage * weight, shadow_info.g * weight,
    geometry, shadow_info.a * weight);
```

Update the Lua resolve call to pass both textures and the new constants:

```lua
obj.pixelshader("resolve_shadow", "cache:longshadown_resolved",
    { "cache:longshadown_shadow_a", "cache:longshadown_source" },
    { buffer_w, buffer_h, fade_in / 100, fade_out / 100, work_scale,
      source_offset_x, source_offset_y, source_w, source_h }, "copy", "clamp")
```

- [ ] **Step 5: Make edge refinement emit the same resolved contract**

Immediately before the refined ray loop, sample the subpixel root:

```hlsl
float root_alpha = sample_source_alpha(pixel);
```

After the loop computes total `coverage`, reconstruct extension and use it in
the red contribution channel:

```hlsl
float extension_coverage = reconstruct_extension_coverage(
    coverage, root_alpha);
float weight = fade_weight_aa(first_distance);
float weighted_coverage = coverage * weight;
float4 contribution = float4(extension_coverage * weight,
    first_distance * weighted_coverage,
    found_source ? 1 : 0, weighted_coverage);
```

- [ ] **Step 6: Run Task 1 tests and shader compilation**

Run:

```powershell
node --test --test-name-pattern="extension coverage separates|resolved extension is reconstructed|edge refinement emits|all embedded pixel shaders compile" tests/composite-shadow.test.mjs
```

Expected: all selected tests PASS and FXC compiles every embedded shader.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Track positive-distance shadow coverage"
```

---

### Task 2: Select extension coverage before styling

**Files:**
- Modify: `LongShadowN.anm2:566-665` — shadow coverage selection.
- Modify: `LongShadowN.anm2:823-864` — final overlap compositor.
- Modify: `LongShadowN.anm2:1118-1150` — style shader constants.
- Modify: `LongShadowN.anm2:1198-1206` — final compositor inputs.
- Modify: `tests/composite-shadow.test.mjs:613-750` — opacity, outline, and wiring tests.

**Interfaces:**
- Consumes: resolved `.r` extension coverage, resolved `.a` total coverage, normalized `object_opacity`, styled premultiplied shadow, and original premultiplied source.
- Produces: `float select_shadow_coverage(float4 shadow_info)` and `float4 prepare_shadow_for_object(float4 shadow, float4 source)`.
- Removes: final dependence on first-hit distance and the resolved metadata texture from `composite_shadow`.

- [ ] **Step 1: Add failing coverage-selection and full-composition tests**

Add this constant-folded selection test:

```js
test("Object Opacity selects extension before shadow styling", () => {
  const source = readFileSync(scriptPath, "utf8");
  const selectCoverage = extractFunction(source, "select_shadow_coverage");
  const cases = [["0", "0.4"], ["0.5", "0.6"], ["1", "0.8"]];
  for (const [opacity, expected] of cases) {
    const assembly = compileConstantResult(`
static const float object_opacity = ${opacity};
${selectCoverage}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float result = select_shadow_coverage(float4(0.4, 0.2, 1, 0.8));
    bool correct = abs(result - ${expected}) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      `Object Opacity ${opacity}`);
  }
});
```

Replace the old exact-distance rejection test with a structural/wiring test:

```js
test("final compositing no longer guesses extension from first-hit distance", () => {
  const source = readFileSync(scriptPath, "utf8");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  assert.doesNotMatch(prepareShadow, /shadow_info|distance/);
  const composite = extractFunction(source, "composite_shadow");
  assert.doesNotMatch(composite, /shadow_info_texture/);
  assert.match(source,
    /obj\.pixelshader\("composite_shadow",\s*"object",\s*\{\s*"cache:longshadown_final",\s*"cache:longshadown_source"\s*\}/);
});
```

Add a complete source-over test at opacity 0 and 0.5:

```js
test("full composition keeps fractional overlap premultiplied", () => {
  const source = readFileSync(scriptPath, "utf8");
  const colorObject = extractFunction(source, "color_object");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  const cases = [
    ["0", "float4(0, 0, 0.25, 0.25)"],
    ["0.5", "float4(0.25, 0.25, 0.53125, 0.53125)"],
  ];
  for (const [opacity, expected] of cases) {
    const assembly = compileConstantResult(`
static const float3 object_rgb = float3(1, 1, 1);
static const float object_mix = 0;
static const float object_opacity = ${opacity};
${colorObject}
${prepareShadow}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 original = float4(0.5, 0.5, 0.5, 0.5);
    float4 shadow = prepare_shadow_for_object(
        float4(0, 0, 0.5, 0.5), original);
    float4 styled = color_object(original);
    float4 result = styled + shadow * (1 - styled.a);
    bool correct = all(abs(result - ${expected}) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      `full composition opacity ${opacity}`);
  }
});
```

- [ ] **Step 2: Run Task 2 tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="selects extension before|no longer guesses extension|full composition keeps" tests/composite-shadow.test.mjs
```

Expected: FAIL because `select_shadow_coverage was not found`, the compositor
still accepts `shadow_info`, and the full composition helper signature differs.

- [ ] **Step 3: Select coverage in `style_shadow` before post-processing**

Add normalized Object Opacity to the end of the `style_shadow` constant buffer
and add:

```hlsl
float select_shadow_coverage(float4 shadow_info) {
    return lerp(shadow_info.r, shadow_info.a, object_opacity);
}
```

Change the styled alpha calculation to:

```hlsl
float solid_alpha = select_shadow_coverage(shadow_info) * shadow_opacity;
```

Append `object_opacity / 100` to the constants passed by both the repeating and
clamped `style_shadow` Lua calls. Do not change their texture inputs.

- [ ] **Step 4: Remove first-hit guessing from the final compositor**

Remove `shadow_info_texture : register(t2)`, the local `shadow_info` read, and
the third helper parameter. Keep only continuous overlap attenuation:

```hlsl
float4 prepare_shadow_for_object(float4 shadow, float4 source) {
    float overlap_weight = 1 - source.a * (1 - object_opacity);
    return shadow * overlap_weight;
}
```

Call the helper with `shadow` and `source_sample`, retain `color_object` and
premultiplied source-over, and change the Lua compositor input list to exactly:

```lua
{ "cache:longshadown_final", "cache:longshadown_source" }
```

- [ ] **Step 5: Run Task 2 focused tests and shader compilation**

Run:

```powershell
node --test --test-name-pattern="selects extension before|no longer guesses extension|full composition keeps|continuous source antialiasing|Object Opacity attenuates|Object Mix|all embedded pixel shaders compile" tests/composite-shadow.test.mjs
```

Expected: all selected tests PASS and every embedded shader compiles.

- [ ] **Step 6: Run full automated verification**

Run:

```powershell
node --test tests/*.test.mjs
git diff --check
```

Expected: all tests PASS; FXC may emit the existing `X3577` `isfinite` warning;
`git diff --check` reports no errors.

- [ ] **Step 7: Inspect protocol and scope**

Run:

```powershell
rg -n "reconstruct_extension_coverage|select_shadow_coverage|shadow_info_texture|first_distance|overlap_weight|resolve_shadow|style_shadow" LongShadowN.anm2 tests/composite-shadow.test.mjs
git diff -- LongShadowN.anm2 tests/composite-shadow.test.mjs
```

Expected:

- resolve and edge refinement both write extension coverage to `.r`;
- style selects `.r`/`.a` before smoothing and blur;
- final compositing has no resolved texture or distance-zero rejection;
- Direct raw packing, renderer routing, user parameters, and cache-buffer count
  are unchanged.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Remove distance-zero shadow outlines"
```

- [ ] **Step 9: Perform manual AviUtl verification before integration**

Use the reported saturated rainbow shadow and white antialiased text. Check
Object Opacity `0`, `50`, and `100` for Directional, Radial, and Inverse Radial
with Supersampling `None` and `2x`. Repeat with Blur Shadow `0` and one visible
nonzero value.

Acceptance criteria:

- no thin shadow-colored copy around curved or straight source edges at
  Object Opacity zero;
- no root gap at Object Opacity 50 or 100;
- glyph holes retain genuine positive-distance extension;
- partial edges remain antialiased rather than binary;
- quality-tier routing and performance remain unchanged apart from the small
  resolve-time source sample.
