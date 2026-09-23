# Inverse Radial Direct Raymarch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace recursive Fast Inverse Radial resampling with a clipped direct-source raymarch that stays continuous at convergence and remains usable at Standard quality.

**Architecture:** Draft, Standard, and High Inverse Radial pixels analytically intersect their inverse-projection ray with the source rectangle, then sample only that interval from the original source. The existing packed shadow-buffer contract and styling pipeline remain unchanged; Directional, Radial, and Ultra retain their r7 paths.

**Tech Stack:** AviUtl ExEdit2 `.anm2` Lua, embedded HLSL Shader Model 5, Node.js test runner, Windows SDK `fxc.exe`.

**Spec:** `docs/superpowers/specs/2026-09-23-inverse-direct-raymarch-design.md`

## Global Constraints

- Change only Inverse Radial at Draft, Standard, and High quality.
- Keep Directional, Radial, and Ultra behavior unchanged from r7.
- Preserve all existing controls and the packed R/G/B/A shadow-buffer contract.
- Never switch renderers at a Length or convergence threshold.
- Sample only the original source texture; never feed a rendered Inverse shadow into another scale pass.
- Treat the implementation as disposable until manual Standard-quality performance succeeds.

## File Structure

- Modify `LongShadowN.anm2`: add the clipped direct Inverse shader, route non-Ultra Inverse rendering to it, and apply the same clipping to Inverse edge refinement.
- Modify `tests/composite-shadow.test.mjs`: repair the r7 baseline assertions and add shader math, dispatch, packed-output, and refinement tests.
- Do not add runtime dependencies or split the existing single-script distribution.

---

### Task 1: Restore a Green r7 Test Baseline

**Files:**
- Modify: `tests/composite-shadow.test.mjs:100-110`
- Modify: `tests/composite-shadow.test.mjs:223-230`

**Interfaces:**
- Consumes: r7 `LongShadowN.anm2`, whose Blur Shadow range is `0..4000`.
- Produces: a clean 12-test baseline against which renderer changes can be measured.

- [ ] **Step 1: Update the stale Blur Shadow expectation**

Change the test name and literal expectation to match the r7 control:

```js
test("blur shadow exposes a 4000 px range in 0.1 px steps", () => {
  const source = readFileSync(scriptPath, "utf8");
  const match = source.match(
    /^--track@blur_shadow:[^,]+,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/m,
  );
  assert.ok(match, "Blur Shadow track was not found");
  assert.deepEqual(match.slice(1).map(Number), [0, 4000, 0, 0.1]);
});
```

- [ ] **Step 2: Make the blur-pipeline extraction independent of line endings**

Replace the LF-only expression with:

```js
const blurPipeline = source.match(
  /if blur_shadow > 0 then([\s\S]*?)\r?\n    end\r?\nend/,
);
```

- [ ] **Step 3: Run the complete baseline suite**

Run: `node --test tests/composite-shadow.test.mjs`

Expected: PASS, 12 tests, 0 failures.

- [ ] **Step 4: Commit the baseline repair**

```bash
git add tests/composite-shadow.test.mjs
git commit -m "Fix r7 test baseline"
```

---

### Task 2: Add and Test the Clipped Inverse Ray Interval

**Files:**
- Modify: `LongShadowN.anm2:136-200`
- Modify: `tests/composite-shadow.test.mjs`

**Interfaces:**
- Consumes: output pixel, projection origin, source bounds, and `target_scale` in unscaled object coordinates.
- Produces: `bool inverse_ray_interval(float2 pixel, float2 origin, float2 bounds_min, float2 bounds_max, float target_scale, out float start_distance, out float end_distance, out float source_span)`.

- [ ] **Step 1: Write a failing constant-shader test for interval clipping**

Add a test that extracts `inverse_ray_interval`, compiles it with constant inputs, and requires all cases to pass:

```js
test("inverse ray interval clips sampling to the source rectangle", () => {
  const source = readFileSync(scriptPath, "utf8");
  const intervalFunction = extractFunction(source, "inverse_ray_interval", "bool");
  const assembly = compileConstantResult(`
${intervalFunction}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_distance, end_distance, source_span;
    bool hit = inverse_ray_interval(
        float2(0.5, 0), float2(0, 0), float2(-1, -1), float2(1, 1),
        0.25, start_distance, end_distance, source_span);
    bool clipped = hit
        && abs(start_distance - 0) < 1e-5
        && abs(end_distance - 0.5) < 1e-5
        && abs(source_span - 0.5) < 1e-5;

    float miss_start, miss_end, miss_span;
    bool miss = inverse_ray_interval(
        float2(2, 0), float2(0, 0), float2(-2, -1), float2(-1, 1),
        0.25, miss_start, miss_end, miss_span);

    float parallel_start, parallel_end, parallel_span;
    bool parallel = inverse_ray_interval(
        float2(0, 0.5), float2(0, 0), float2(-1, -1), float2(1, 1),
        0.25, parallel_start, parallel_end, parallel_span);

    bool correct = clipped && !miss && parallel;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});
```

- [ ] **Step 2: Run the interval test and verify RED**

Run: `node --test --test-name-pattern="inverse ray interval" tests/composite-shadow.test.mjs`

Expected: FAIL with `inverse_ray_interval was not found`.

- [ ] **Step 3: Add the minimal self-contained HLSL interval function**

Place this function temporarily inside the existing `raymarch_shadow` shader
block so the repository still contains only complete, compilable shader entry
points. Task 3 will move the unchanged function into the complete new Inverse
shader block.

```hlsl
bool inverse_ray_interval(float2 pixel, float2 origin,
    float2 bounds_min, float2 bounds_max, float target_scale,
    out float start_distance, out float end_distance, out float source_span) {
    float safe_scale = max(target_scale, 1e-6);
    float maximum_u = 1 / safe_scale;
    float minimum_u = 1;
    float2 delta = pixel - origin;

    if (abs(delta.x) < 1e-6) {
        if (origin.x < bounds_min.x || origin.x >= bounds_max.x) return false;
    } else {
        float x0 = (bounds_min.x - origin.x) / delta.x;
        float x1 = (bounds_max.x - origin.x) / delta.x;
        minimum_u = max(minimum_u, min(x0, x1));
        maximum_u = min(maximum_u, max(x0, x1));
    }
    if (abs(delta.y) < 1e-6) {
        if (origin.y < bounds_min.y || origin.y >= bounds_max.y) return false;
    } else {
        float y0 = (bounds_min.y - origin.y) / delta.y;
        float y1 = (bounds_max.y - origin.y) / delta.y;
        minimum_u = max(minimum_u, min(y0, y1));
        maximum_u = min(maximum_u, max(y0, y1));
    }
    if (maximum_u < minimum_u) return false;

    float logarithmic_range = max(-log(safe_scale), 1e-6);
    start_distance = saturate(log(max(minimum_u, 1)) / logarithmic_range);
    end_distance = saturate(log(max(maximum_u, 1)) / logarithmic_range);
    source_span = length(delta) * max(maximum_u - minimum_u, 0);
    return end_distance >= start_distance;
}
```

- [ ] **Step 4: Run the interval test and all shader compilation tests**

Run: `node --test --test-name-pattern="inverse ray interval|all embedded pixel shaders compile" tests/composite-shadow.test.mjs`

Expected: PASS, including the hit, miss, parallel-axis, and endpoint cases.

- [ ] **Step 5: Commit the interval primitive**

```bash
git add LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Add clipped inverse ray interval"
```

---

### Task 3: Render Fast Inverse Directly From the Source

**Files:**
- Modify: `LongShadowN.anm2:136-200`
- Modify: `LongShadowN.anm2:1028-1087`
- Modify: `LongShadowN.anm2:1179-1188`
- Modify: `tests/composite-shadow.test.mjs`

**Interfaces:**
- Consumes: `inverse_ray_interval`, `cache:longshadown_source`, `target_scale`, and `quality_step`.
- Produces: `inverse_raymarch_shadow` with the existing packed output contract and `render_inverse_direct(buffer_w, buffer_h, source_pos_x, source_pos_y, work_scale)` returning `target_scale, refine_sample_count, inverse_quality_step`.

- [ ] **Step 1: Write failing tests for packed output and dispatch**

Add `float4 pack_inverse_shadow(float2 encoded_source, float first_distance,
float coverage)` to the new shader. Extract it in the test and compile this
literal behavior check:

```hlsl
float4 result = pack_inverse_shadow(float2(0.25, 0.75), 0.4, 0.5);
bool correct = all(abs(result - float4(0.25, 0.2, 0.75, 0.5)) < 1e-6);
return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
```

Also add a source integration test requiring this dispatch order:

```lua
if effective_quality == 3 then
    render_ultra_raymarch(...)
elseif shadow_type == 0 then
    render_fast_directional(...)
elseif shadow_type == 1 then
    render_radial_scale(...)
elseif shadow_type == 2 then
    render_inverse_direct(...)
end
```

The packed-output test must use literal expected channels: encoded source x in R,
`first_distance * coverage` in G, encoded source y in B, and coverage in A.

- [ ] **Step 2: Run the new tests and verify RED**

Run: `node --test --test-name-pattern="inverse direct|packed inverse" tests/composite-shadow.test.mjs`

Expected: FAIL because `inverse_raymarch_shadow`, its packing helper, and `render_inverse_direct` do not exist.

- [ ] **Step 3: Implement the direct Inverse pixel shader**

Move `inverse_ray_interval` from the Ultra shader block into a new, complete
`pixelshader@inverse_raymarch_shadow` block. Add the cbuffer, original-source
alpha sampler, `pack_inverse_shadow`, and these operations in order:

```hlsl
float2 pixel = pos.xy / work_scale;
float start_distance, end_distance, source_span;
if (!inverse_ray_interval(pixel, projection_origin, source_offset,
        source_offset + source_size, target_scale,
        start_distance, end_distance, source_span)) return 0;

int active_samples = min(8001,
    max(2, (int)ceil(source_span * work_scale / quality_step) + 1));
float coverage = 0;
float first_distance = 1;
float2 first_source_coordinate = 0;
bool found_source = false;

[loop]
for (int sample = 0; sample < 8001; ++sample) {
    if (sample >= active_samples) break;
    float progress = sample == active_samples - 1
        ? 1 : sample / max(active_samples - 1.0, 1.0);
    float distance = lerp(start_distance, end_distance, progress);
    float projection_scale = pow(max(target_scale, 1e-6), distance);
    float2 source_pixel = projection_origin
        + (pixel - projection_origin) / projection_scale;
    float sample_alpha = sample_source_alpha_inverse(source_pixel);
    if (sample_alpha > 0.0001 && !found_source) {
        found_source = true;
        first_distance = distance;
        float2 source_local = clamp(floor(source_pixel - source_offset),
            0, source_size - 1);
        first_source_coordinate = 0.125
            + 0.75 * (source_local + 0.5) / source_size;
    }
    coverage += (1 - coverage) * sample_alpha;
    if (coverage >= 0.9999) break;
}
return pack_inverse_shadow(first_source_coordinate, first_distance, coverage);
```

The shader cbuffer must include `buffer_size`, `source_offset`, `source_size`,
`projection_origin`, `target_scale`, `quality_step`, and `work_scale` in the same
order supplied by Lua.

- [ ] **Step 4: Implement the Lua renderer and dispatch**

Add:

```lua
local function render_inverse_direct(buffer_w, buffer_h,
    source_pos_x, source_pos_y, work_scale)
    local target_scale, effective_length = get_radial_projection(
        shadow_type, shadow_length, source_w, source_h)
    local quality_step = get_quality_config(effective_quality)
    local refine_sample_count = math.min(MAX_DIRECT_SAMPLES,
        math.max(2, math.ceil(effective_length * work_scale / quality_step) + 1))
    obj.clearbuffer("cache:longshadown_shadow_a", buffer_w, buffer_h)
    obj.pixelshader("inverse_raymarch_shadow", "cache:longshadown_shadow_a",
        "cache:longshadown_source",
        { buffer_w, buffer_h, source_offset_x, source_offset_y,
          source_w, source_h, source_pos_x, source_pos_y,
          target_scale, quality_step, work_scale }, "copy", "clamp")
    return target_scale, refine_sample_count, quality_step
end
```

Keep the Ultra branch first, split Radial and Inverse into separate branches,
and pass the third return value through to the style stage for Task 4.

- [ ] **Step 5: Run targeted and complete automated tests**

Run: `node --test --test-name-pattern="inverse direct|packed inverse|all embedded pixel shaders compile" tests/composite-shadow.test.mjs`

Then run: `node --test tests/composite-shadow.test.mjs`

Expected: all tests PASS and every embedded shader compiles.

- [ ] **Step 6: Commit direct Inverse rendering**

```bash
git add LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Render fast inverse shadows from source"
```

---

### Task 4: Clip Inverse Boundary Refinement to the Same Interval

**Files:**
- Modify: `LongShadowN.anm2:201-327`
- Modify: `LongShadowN.anm2:1089-1108`
- Modify: `tests/composite-shadow.test.mjs`

**Interfaces:**
- Consumes: the direct renderer's `inverse_quality_step`, target scale, source bounds, and projection origin.
- Produces: Inverse `edge_antialias` refinement that visits only the clipped source interval; all other shadow types keep the r7 refinement path.

- [ ] **Step 1: Write a failing integration test for clipped Inverse refinement**

Extract the `edge_antialias` shader block and assert with the following literal
patterns that its Inverse branch:

1. calls an interval helper with each refined subpixel;
2. derives `active_sample_count` from `source_span * work_scale / inverse_quality_step`;
3. interpolates distance only from the clipped start to end;
4. retains the existing Directional and Radial branches.

Also require the Lua `edge_antialias` call to pass `inverse_quality_step` after
the existing fade and dense-refine constants.

```js
assert.match(edgeShader, /shadow_type >= 1\.5[\s\S]*?inverse_ray_interval/);
assert.match(edgeShader,
  /ceil\(source_span \* work_scale \/ inverse_quality_step\) \+ 1/);
assert.match(edgeShader,
  /distance = lerp\(start_distance, end_distance,[\s\S]*?sample/);
assert.match(edgeCall, /dense_refine, inverse_quality_step, work_scale/);
```

- [ ] **Step 2: Run the refinement test and verify RED**

Run: `node --test --test-name-pattern="clipped inverse refinement" tests/composite-shadow.test.mjs`

Expected: FAIL because the edge shader still scans the full normalized range.

- [ ] **Step 3: Add the clipped Inverse branch to `edge_antialias`**

Duplicate the exact `inverse_ray_interval` function inside the independently
compiled `edge_antialias` shader block. Add `inverse_quality_step` and
`work_scale` constants. For `shadow_type >= 1.5`, calculate the interval for
each subpixel, contribute transparent coverage on a miss, and use:

```hlsl
active_sample_count = min(8001,
    max(2, ceil(source_span * work_scale / inverse_quality_step) + 1));
distance = lerp(start_distance, end_distance,
    sample == active_sample_count - 1
        ? 1 : sample / max(active_sample_count - 1.0, 1.0));
```

Keep the current Directional expression for `shadow_type < 0.5` and the current
Radial expression for `0.5 <= shadow_type < 1.5`. Preserve subpixel weights,
first-source capture, Fade metadata, and packed output.

- [ ] **Step 4: Pass refinement spacing through `style_and_filter_shadow`**

Extend the Lua function signature with `inverse_quality_step`, default it to `1`
for non-Inverse paths, and append it plus `work_scale` to the edge shader constants.
Do not change any style, blur, texture, or final composite call.

- [ ] **Step 5: Run all automated verification**

Run: `node --test tests/composite-shadow.test.mjs`

Run: `git diff --check`

Expected: all tests PASS, all shaders compile, and no whitespace errors exist.

- [ ] **Step 6: Commit clipped boundary refinement**

```bash
git add LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Clip inverse boundary refinement"
```

---

### Task 5: Manual Quality and Performance Gate

**Files:**
- Inspect: `LongShadowN.anm2`
- Compare: tag `r7`

**Interfaces:**
- Consumes: the completed experimental renderer.
- Produces: a keep-or-revert decision; no approximation is accepted merely because automated tests pass.

- [ ] **Step 1: Capture a clean automated verification result**

Run: `node --test tests/composite-shadow.test.mjs`

Run: `git diff --check`

Expected: 0 test failures and 0 whitespace errors.

- [ ] **Step 2: Verify rendering continuity in AviUtl**

Using the same text/sparse-alpha project that reproduced the bug, compare short,
near-converged, and fully converged Length values at Draft, Standard, High, and
Ultra. Confirm there is no renderer switch, fan-shaped separation, comb gap,
fragment, or whole-shadow discontinuity.

- [ ] **Step 3: Verify styling compatibility**

Exercise Fade In/Out, Shadow Color and Opacity, Object Color/Mix/Opacity, 1D and
2D textures, Blur Shadow, Post Smooth, and Supersampling. Compare against r7 at
non-converged Length values.

- [ ] **Step 4: Evaluate Standard interaction performance**

Scrub Length through convergence and manipulate the source point. The success
criterion is that Standard remains practically interactive on the user's actual
project while keeping the corrected image.

- [ ] **Step 5a: Keep the implementation only on success**

If image continuity, compatibility, and Standard performance all pass, record
the tested settings in the commit message and commit any final test-only
adjustments:

```bash
git add LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Finalize direct inverse radial renderer"
```

- [ ] **Step 5b: Revert the experiment on failure**

If Standard is not usable or appearance regresses, revert only the implementation
commits from Tasks 2-4, leaving the approved design and test-baseline repair in
history. Verify that `LongShadowN.anm2` matches r7 before reporting the failure.
