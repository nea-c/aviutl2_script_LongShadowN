# Unified Direct Shadow Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Radial and Inverse Radial renderer plus High and Ultra Directional with one clipped direct-source renderer while retaining the fast Directional path for Draft and Standard.

**Architecture:** One embedded HLSL shader computes a mode-specific clipped interval and traverses it with a shared source-sampling loop. Lua exposes one `render_direct_shadow` entry point, and edge refinement mirrors the same interval and parameter rules. The packed shadow-buffer contract remains unchanged so the downstream pipeline remains compatible.

**Tech Stack:** AviUtl2 `.anm2` Lua, Direct3D 11 HLSL compiled with FXC, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-23-unified-direct-shadow-design.md`

## Global Constraints

- Keep the four quality choices and saved-project numeric values unchanged.
- Requested spacings remain Draft `4.0`, Standard `2.0`, High `1.0`, Ultra `0.5` source pixels.
- Edge-refinement counts remain `4`, `8`, `12`, `16`.
- `MAX_DIRECT_SAMPLES` remains `8001`; capped rays cover the complete interval and include both endpoints.
- Directional Draft/Standard retain `render_fast_directional`; Directional High/Ultra use Direct.
- Every Radial and Inverse Radial quality uses Direct.
- Preserve packed channels and existing Fade, texture, color, Blur Shadow, object compositing, supersampling, padding, and source-position behavior.
- Add no dependency and change no public `.anm2` parameter.

## Review Focus

- Half-open upper bounds and corner tangencies must not create fragments; Task 1 adds compiled hit/miss tests.
- Projection scales extremely close to one must stay finite and continuous; Task 1 adds a near-unit test.
- More than 8001 requested samples must still reach the far endpoint; Tasks 1 and 2 pin this.
- Directional Draft/Standard must stay fast while High/Ultra go Direct; Task 2 tests all levels.
- Edge refinement must use the main pass's interval, spacing, and distance rules; Task 3 tests shader and Lua wiring.

---

### Task 1: Generalized clipped Direct shader

**Files:**
- Modify: `LongShadowN.anm2:201-362`
- Modify: `tests/composite-shadow.test.mjs:43-379`

**Interfaces:**
- Consumes: the packed channels `(source_x, distance * coverage, source_y, coverage)`.
- Produces: shader `direct_raymarch_shadow`; helpers `directional_ray_interval`, `projection_ray_interval`, `projection_distance_from_u`, `direct_sample_parameter`.

- [ ] **Step 1: Write failing compiled interval tests**

Replace Inverse-only helper assertions with this generalized test, retaining the existing narrow-crossing and excluded-tangent cases under `projection_ray_interval`:

```js
test("direct interval helpers clip directional radial and inverse rays", () => {
  const source = readFileSync(scriptPath, "utf8");
  const directional = extractFunction(source, "directional_ray_interval", "bool");
  const projection = extractFunction(source, "projection_ray_interval", "bool");
  const distanceFromU = extractFunction(source, "projection_distance_from_u", "float");
  const assembly = compileConstantResult(`
${directional}
${projection}
${distanceFromU}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float ds, de, dspan;
    bool dh = directional_ray_interval(float2(3, .5), float2(1, 0), 4,
        float2(0, 0), float2(1, 1), ds, de, dspan);
    float ms, me, mspan;
    bool dm = directional_ray_interval(float2(3, 2), float2(1, 0), 4,
        float2(0, 0), float2(1, 1), ms, me, mspan);
    float is, ie, ispan;
    bool ih = projection_ray_interval(float2(.5, 0), float2(0, 0), .25,
        float2(-1, -1), float2(1, 1), is, ie, ispan);
    float rs, re, rspan;
    bool rh = projection_ray_interval(float2(.5, 0), float2(0, 0), 2,
        float2(.3, -1), float2(.4, 1), rs, re, rspan);
    float near = projection_distance_from_u(1.0000001, .99999995);
    bool ok = dh && !dm && ds >= .5 && ds < .5001
        && abs(de - .75) < 1e-4 && abs(dspan - 1) < 1e-4
        && ih && is < ie && abs(ispan - .5) < 1e-3
        && rh && rs > re && abs(rspan - .1) < 1e-3
        && isfinite(near) && near >= 0 && near <= 1;
    return ok ? float4(0,1,0,1) : float4(1,0,0,1);
}`);
  assert.match(assembly, /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/);
});
```

- [ ] **Step 2: Write a failing endpoint/cap test**

```js
test("direct sampling includes both endpoints when capped", () => {
  const source = readFileSync(scriptPath, "utf8");
  const fn = extractFunction(source, "direct_sample_parameter", "float");
  const assembly = compileConstantResult(`
${fn}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float a = direct_sample_parameter(3, 9003, 0, 8001);
    float b = direct_sample_parameter(3, 9003, 7999, 8001);
    float c = direct_sample_parameter(3, 9003, 8000, 8001);
    bool ok = a == 3 && c == 9003 && b < c
        && abs((c - a) / 8000 - 1.125) < 1e-6;
    return ok ? float4(0,1,0,1) : float4(1,0,0,1);
}`);
  assert.match(assembly, /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/);
});
```

- [ ] **Step 3: Verify the new tests fail**

Run: `node --test --test-name-pattern="direct interval helpers|direct sampling includes" tests/composite-shadow.test.mjs`

Expected: FAIL because the generalized helpers do not exist.

- [ ] **Step 4: Implement the generalized shader**

Rename `inverse_raymarch_shadow` to `direct_raymarch_shadow` and use this constant order:

```hlsl
float2 buffer_size; float2 source_offset; float2 source_size;
float2 projection_origin; float2 direction; float total_length;
float target_scale; float shadow_type; float quality_step; float work_scale;
```

Build both intervals on this slab primitive:

```hlsl
bool clip_parameter_axis(float origin, float delta, float bounds_min,
    float bounds_max, inout float interval_min, inout float interval_max) {
    if (abs(delta) < 1e-6)
        return origin >= bounds_min && origin < bounds_max;
    float first = (bounds_min - origin) / delta;
    float last = (bounds_max - origin) / delta;
    interval_min = max(interval_min, min(first, last));
    interval_max = min(interval_max, max(first, last));
    return interval_max >= interval_min;
}
float direct_sample_parameter(float start_parameter, float end_parameter,
    int sample, int active_samples) {
    if (sample == active_samples - 1) return end_parameter;
    return lerp(start_parameter, end_parameter,
        sample / max(active_samples - 1.0, 1.0));
}
```

Directional uses origin `pixel`, delta `-direction * total_length`, domain `[0,1]`. Projection uses origin `projection_origin`, delta `pixel - projection_origin`, and the unordered domain between `1` and `1 / max(target_scale, 1e-6)`; return endpoints in traversal order. Reuse the existing binary endpoint refinement for half-open upper bounds. Both set `source_span = length(delta) * abs(end_parameter - start_parameter)`.

Use this finite Projection metadata conversion:

```hlsl
float projection_distance_from_u(float target_scale, float u) {
    float safe_scale = max(target_scale, 1e-6);
    float range = -log(safe_scale);
    if (abs(range) < 1e-6) {
        float linear_range = 1 / safe_scale - 1;
        if (abs(linear_range) < 1e-7) return 0;
        return saturate((u - 1) / linear_range);
    }
    return saturate(log(max(u, 1e-6)) / range);
}
```

Select the interval by `shadow_type < 0.5`. Compute `active_samples = min(8001, max(2, ceil(source_span * work_scale / quality_step) + 1))`. Directional reconstructs `pixel - direction * (parameter * total_length)` with `distance = parameter`; Projection reconstructs `projection_origin + (pixel - projection_origin) * parameter` with `distance = projection_distance_from_u(...)`. Preserve first-hit encoding, alpha union, early opaque exit, and packed output.

- [ ] **Step 5: Run focused and compilation tests**

Run: `node --test --test-name-pattern="direct interval helpers|direct sampling includes|all embedded pixel shaders compile" tests/composite-shadow.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Add generalized clipped direct shader"
```

---

### Task 2: Lua renderer and quality routing

**Files:**
- Modify: `LongShadowN.anm2:1356-1388,1481-1498`
- Modify: `tests/composite-shadow.test.mjs:287-369,480-497`

**Interfaces:**
- Consumes: `direct_raymarch_shadow` from Task 1.
- Produces: `render_direct_shadow(buffer_w, buffer_h, source_pos_x, source_pos_y, work_scale) -> target_scale, refine_sample_count, direct_quality_step`.

- [ ] **Step 1: Write failing renderer and routing tests**

```js
test("Lua direct renderer and routing match the approved matrix", () => {
  const source = readFileSync(scriptPath, "utf8");
  const renderer = source.match(/local function render_direct_shadow\([\s\S]*?\r?\nend/);
  assert.ok(renderer, "render_direct_shadow was not found");
  assert.match(renderer[0], /local target_scale, effective_length = 1, shadow_length/);
  assert.match(renderer[0], /if shadow_type >= 1 then[\s\S]*?get_radial_projection/);
  assert.match(renderer[0], /obj\.pixelshader\("direct_raymarch_shadow"/);
  assert.match(renderer[0], /return target_scale, refine_sample_count, quality_step/);
  const dispatch = source.match(/if should_render_shadow then[\s\S]*?\r?\nelse/);
  assert.match(dispatch[0], /if shadow_type == 0 and effective_quality < 2 then[\s\S]*?render_fast_directional/);
  assert.match(dispatch[0], /else[\s\S]*?render_direct_shadow/);
  assert.doesNotMatch(dispatch[0], /render_ultra_raymarch|render_radial_scale|render_inverse_direct/);
});
```

Extend the quality table test with `assert.match(qualityConfig[1], /\[3\] = \{ sample_step = 0\.5,/);`.

- [ ] **Step 2: Verify the routing test fails**

Run: `node --test --test-name-pattern="Lua direct renderer and routing" tests/composite-shadow.test.mjs`

Expected: FAIL against the old Inverse-only/Ultra dispatch.

- [ ] **Step 3: Implement `render_direct_shadow`**

```lua
local function render_direct_shadow(buffer_w, buffer_h,
    source_pos_x, source_pos_y, work_scale)
    local target_scale, effective_length = 1, shadow_length
    if shadow_type >= 1 then
        target_scale, effective_length = get_radial_projection(
            shadow_type, shadow_length, source_w, source_h)
    end
    local quality_step = get_quality_config(effective_quality)
    local refine_sample_count = math.min(MAX_DIRECT_SAMPLES,
        math.max(2, math.ceil(effective_length * work_scale / quality_step) + 1))
    obj.clearbuffer("cache:longshadown_shadow_a", buffer_w, buffer_h)
    obj.pixelshader("direct_raymarch_shadow", "cache:longshadown_shadow_a",
        "cache:longshadown_source",
        { buffer_w, buffer_h, source_offset_x, source_offset_y,
          source_w, source_h, source_pos_x, source_pos_y,
          math.cos(math.rad(angle)), math.sin(math.rad(angle)),
          shadow_length, target_scale, shadow_type, quality_step, work_scale },
        "copy", "clamp")
    return target_scale, refine_sample_count, quality_step
end
```

- [ ] **Step 4: Implement the matrix dispatch**

```lua
local direct_quality_step
local _, refine_samples = get_quality_config(effective_quality)
if shadow_type == 0 and effective_quality < 2 then
    refine_sample_count = render_fast_directional(
        work_w, work_h, source_offset_x, source_offset_y, work_scale)
else
    target_scale, refine_sample_count, direct_quality_step = render_direct_shadow(
        work_w, work_h, source_pos_x, source_pos_y, work_scale)
end
style_and_filter_shadow(obj.w, obj.h, work_scale,
    target_scale, refine_sample_count, refine_samples, direct_quality_step)
```

Keep old unreachable functions until Task 4.

- [ ] **Step 5: Run routing, quality, and compilation tests**

Run: `node --test --test-name-pattern="Lua direct renderer and routing|quality spacing|all embedded pixel shaders compile" tests/composite-shadow.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Route selected shadow tiers through direct renderer"
```

---

### Task 3: Shared Direct edge refinement

**Files:**
- Modify: `LongShadowN.anm2:363-614,1390-1411`
- Modify: `tests/composite-shadow.test.mjs:374-492`

**Interfaces:**
- Consumes: Task 1 interval semantics and Task 2 `direct_quality_step`.
- Produces: Direct refinement for every Direct path and legacy refinement only for Directional Draft/Standard.

- [ ] **Step 1: Write failing shader and Lua contract tests**

```js
test("edge refinement mirrors generalized Direct traversal", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(/--\[\[pixelshader@edge_antialias:\s*([\s\S]*?)\]\]/)[1];
  assert.match(shader, /float direct_quality_step;/);
  assert.match(shader, /bool directional_ray_interval\(/);
  assert.match(shader, /bool projection_ray_interval\(/);
  assert.match(shader, /if \(direct_quality_step > 0\)/);
  assert.match(shader, /ceil\(source_span \* work_scale \/ direct_quality_step\) \+ 1/);
  assert.match(shader, /direct_sample_parameter\(start_parameter, end_parameter,/);
  assert.doesNotMatch(shader, /inverse_quality_step|inverse_ray_interval|inverse_sample_u/);
  const style = source.match(/local function style_and_filter_shadow\([\s\S]*?\r?\nend/)[0];
  assert.match(style, /target_scale, refine_sample_count, refine_samples, direct_quality_step\)/);
  assert.match(style, /direct_quality_step = direct_quality_step or 0/);
  assert.match(style, /fade_in \/ 100, fade_out \/ 100[\s\S]*?direct_quality_step, work_scale/);
});
```

- [ ] **Step 2: Verify the test fails**

Run: `node --test --test-name-pattern="edge refinement mirrors" tests/composite-shadow.test.mjs`

Expected: FAIL because refinement remains Inverse-only.

- [ ] **Step 3: Generalize the edge shader**

Rename the cbuffer field to `direct_quality_step` and copy Task 1's helper bodies into this separately compiled shader. For each refined subpixel:

```hlsl
if (direct_quality_step > 0) {
    bool hit;
    if (shadow_type < 0.5) {
        hit = directional_ray_interval(pixel, direction, total_length,
            source_offset, source_offset + source_size,
            start_parameter, end_parameter, source_span);
    } else {
        hit = projection_ray_interval(pixel, projection_origin, target_scale,
            source_offset, source_offset + source_size,
            start_parameter, end_parameter, source_span);
    }
    if (!hit) continue;
    active_samples = min(8001,
        max(2, (int)ceil(source_span * work_scale / direct_quality_step) + 1));
}
```

Use `direct_sample_parameter` in the loop. Directional treats it as normalized distance; Projection treats it as `u` and calls `projection_distance_from_u`. Preserve Fade weight, contribution packing, and `refined / refine_samples`. The zero-sentinel branch retains only the legacy Directional traversal.

- [ ] **Step 4: Rename and pass the sentinel through Lua**

Change the `style_and_filter_shadow` signature, default, `edge_antialias` constants, and dispatch call from `inverse_quality_step` to `direct_quality_step`. Keep normalized Fade and constant ordering unchanged.

- [ ] **Step 5: Run refinement and downstream regression tests**

Run: `node --test --test-name-pattern="edge refinement mirrors|fade controls|packed|all embedded pixel shaders compile" tests/composite-shadow.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Use clipped direct sampling for edge refinement"
```

---

### Task 4: Remove obsolete renderers and verify the branch

**Files:**
- Modify: `LongShadowN.anm2:136-200,615-679,1313-1388`
- Modify: `tests/composite-shadow.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: one Direct implementation plus the retained fast Directional Draft/Standard path.

- [ ] **Step 1: Write a failing dead-code test**

```js
test("obsolete radial and Ultra renderers are removed", () => {
  const source = readFileSync(scriptPath, "utf8");
  for (const name of ["raymarch_shadow", "inverse_raymarch_shadow", "radial_step", "smooth_distance"])
    assert.doesNotMatch(source, new RegExp(`pixelshader@${name}:`));
  for (const name of ["render_radial_scale", "render_inverse_direct", "render_ultra_raymarch"])
    assert.doesNotMatch(source, new RegExp(`local function ${name}`));
  assert.match(source, /pixelshader@directional_step:/);
  assert.match(source, /local function render_fast_directional/);
  assert.match(source, /pixelshader@direct_raymarch_shadow:/);
  assert.match(source, /local function render_direct_shadow/);
});
```

- [ ] **Step 2: Verify the test fails**

Run: `node --test --test-name-pattern="obsolete radial and Ultra" tests/composite-shadow.test.mjs`

Expected: FAIL while legacy blocks remain.

- [ ] **Step 3: Delete only unreachable legacy code**

Remove shader blocks `raymarch_shadow`, `inverse_raymarch_shadow`, `radial_step`, `smooth_distance` and Lua functions `render_radial_scale`, `render_inverse_direct`, `render_ultra_raymarch`. Keep `seed_shadow`, `directional_step`, and `render_fast_directional`. Rewrite old Inverse-name tests under the generalized helper names rather than deleting their edge cases.

- [ ] **Step 4: Run the complete suite**

Run: `node --test tests/composite-shadow.test.mjs`

Expected: every test passes, including FXC compilation.

- [ ] **Step 5: Check the diff**

Run:

```powershell
git diff --check
git status --short
```

Expected: the first command emits no output; status lists only intended `.anm2` and test changes.

- [ ] **Step 6: Commit**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Remove obsolete radial shadow renderers"
```

- [ ] **Step 7: Hand off manual visual/performance comparison**

Ask the user to compare Directional High/Ultra and every Radial/Inverse quality at short and long Length, animated Length, and with Blur Shadow. For Radial/Inverse, include convergence and off-canvas sources. Do not claim visual acceptance until the user confirms there is no discontinuity, fragment, endpoint loss, or noticeable slowdown.
