# Directional Layered Blur Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test whether separately blurred front and rear Directional shadow layers remove the dark wedges visible with Fade 50 and Blur Shadow 40.

**Architecture:** The Direct ray shader will emit either its current flattened result or one of two ordered layers. Existing resolve, source-color, style, and blur shaders will process each layer serially. A new shader will remove only the rear coverage already covered by the blurred front, apply Shadow Opacity once, and pass the result to the unchanged object compositor. Raw rear data must survive until after blur. Only Directional with Blur Shadow above zero enters this branch.

**Tech Stack:** AviUtl2 `.anm2` Lua/HLSL, Direct3D pixel shaders compiled by Windows SDK `fxc.exe`, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-23-directional-layered-blur-design.md`

## Global Constraints

- Do not change track names, defaults, serialized values, or asset formats.
- Directional Blur Shadow 0, Radial, and Inverse Radial retain the current single-layer path.
- Retain the 8001-sample limit, buffer-size limits, and supersampling fallback.
- The experimental branch applies Fade and root subtraction per sample, and Shadow Opacity exactly once.
- Do not claim a visual fix until the user checks the reported scene in AviUtl2.
- Preserve unrelated worktree modifications, especially `README.md` and the pending Fade-distance changes in `LongShadowN.anm2`, `tests/composite-shadow.test.mjs`, and the continuous-compositing spec.

## Review Focus

- A one-pixel transparent gap between source intervals should select the later interval as rear without a fixed-distance band (Task 1 test).
- A single glyph intersecting distances on both sides of 0.5 must remain one front interval (Task 1 test).
- Fade 50 with a partially transparent root must not create extra shadow coverage or a discontinuous layer switch (Task 1 test).
- A textured shadow with partial texture alpha and Shadow Opacity 50% must not multiply either alpha factor twice (Task 2 test).
- A no-shadow frame after a layered frame must not reuse either layer's previous contents (Task 3 test).

---

### Task 1: Emit front and rear Direct metadata without changing the baseline path

**Files:**
- Modify: `LongShadowN.anm2` (`direct_raymarch_shadow` and `edge_antialias` shader blocks)
- Modify: `tests/composite-shadow.test.mjs`

**Interfaces:**
- Consumes: Existing `conditional_shadow_coverage(sample_alpha, root_alpha)`, `fade_weight_sample(distance)`, and `accumulate_faded_shadow_sample(...)` in both shader blocks.
- Produces: `float layer_selector` appended to both shader constant buffers. `-1` means current flattened result, `0` front, `1` rear. `accumulate_layered_sample(float sample_alpha, float root_alpha, float distance, float fade_weight, float2 source_coordinate, inout LayeredSampleState state)` updates front/rear coverage, weighted distance, source coordinates, and first-interval state. Both shader entry points return the existing packed RGBA contract for the selected layer.

- [ ] **Step 1: Add one failing behavior test for ordered intervals.** In `tests/composite-shadow.test.mjs`, extract the `LayeredSampleState` declaration, `accumulate_layered_sample`, and `pack_layered_shadow` from the Direct shader and compile a constant-result entry point. The core fixture is:

```hlsl
LayeredSampleState state = (LayeredSampleState)0;
accumulate_layered_sample(.4, 0, .3, 1, float2(.2,.2), state);
accumulate_layered_sample(0, 0, .5, 1, 0, state);
accumulate_layered_sample(.8, 0, .8, 1, float2(.8,.8), state);
float4 front = pack_layered_shadow(state, 0);
float4 rear = pack_layered_shadow(state, 1);
float recomposed = max(front.a, rear.a);
bool correct = abs(front.a-.4)<1e-5 && abs(front.g/front.a-.3)<1e-5
    && abs(rear.a-.8)<1e-5 && abs(rear.g/rear.a-.8)<1e-5
    && abs(recomposed-.8)<1e-5;
return correct ? float4(0,1,0,1) : float4(1,0,0,1);
```

Use `compileConstantResult` and the existing green-output assembly assertion. Add a second fixture with supported samples at distances `.49` and `.51` and no empty sample; both must remain front. Add a third fixture with root alpha `.25` and Fade 50 weights supplied to the helper; recomposed coverage must equal the maximum faded conditional coverage. Add an opaque-front fixture with a later rear hit and assert rear alpha remains nonzero before blur.
- [ ] **Step 2: Run `node --test tests/composite-shadow.test.mjs` and confirm the new tests fail because `accumulate_layered_sample` does not exist.**
- [ ] **Step 3: Add the minimal helper to each shader block, using the same implementation in both.** Define this state and transition logic, with `pack_layered_shadow` returning `(source.x, weighted_distance, source.y, coverage)`:

```hlsl
struct LayeredSampleState {
    float front_coverage, front_distance;
    float rear_coverage, rear_distance;
    float2 front_source, rear_source;
    bool front_started, front_open;
};
void accumulate_layered_sample(float sample_alpha, float root_alpha,
    float distance, float fade_weight, float2 source_coordinate,
    inout LayeredSampleState state) {
    float support = conditional_shadow_coverage(sample_alpha, root_alpha);
    if (support <= 1.0 / 255.0) {
        if (state.front_started) state.front_open = false;
        return;
    }
    if (!state.front_started) { state.front_started = true; state.front_open = true; }
    float candidate = support * fade_weight;
    bool front = state.front_open;
    float previous = front ? state.front_coverage : state.rear_coverage;
    float combined = max(previous, candidate);
    float gain = combined - previous;
    if (front) {
        state.front_coverage = combined;
        state.front_distance += distance * gain;
        if (gain > 1e-7) state.front_source = source_coordinate;
    } else {
        state.rear_coverage = combined;
        state.rear_distance += distance * gain;
        if (gain > 1e-7) state.rear_source = source_coordinate;
    }
}
```

`pack_layered_shadow` returns the selected layer's **raw** coverage and weighted distance; do not subtract front coverage here. Return zero when the selected layer's coverage is zero. Preserve the existing baseline branch for selector `-1` and select each source coordinate from the sample that last increased that layer's coverage. In layered mode, do not stop scanning at front coverage `1`, because later rear support is still needed for blur.
- [ ] **Step 4: Make edge refinement use the same layer selector and interval rule at each subpixel.** Keep its current work-scale downsampling and geometric-edge detection. Inside its existing subpixel loop, use the same selector branch as the main renderer:

```hlsl
LayeredSampleState layer_state = (LayeredSampleState)0;
accumulate_layered_sample(sample_alpha, root_alpha, distance,
    fade_weight_sample(distance), source_coordinate, layer_state);
float4 contribution = pack_layered_shadow(layer_state, layer_selector);
```

The `-1` branch retains the current `accumulate_faded_shadow_sample` path. Refine only the selected layer; no global distance cutoff is permitted. A layer with no coverage returns zero metadata, not a stale coordinate.
- [ ] **Step 5: Run `node --test tests/composite-shadow.test.mjs`; expect all tests to pass and all embedded HLSL shaders to compile.**
- [ ] **Step 6: Commit only Task 1 code and tests, after checking the staged diff excludes unrelated edits.** If the pending Fade-distance hunks overlap, stage Task 1 hunks selectively; do not silently include or discard the existing work.

### Task 2: Recombine separately styled layers with one global opacity

**Files:**
- Modify: `LongShadowN.anm2` (new `combine_shadow_layers` shader block and `style_and_filter_shadow` opacity argument)
- Modify: `tests/composite-shadow.test.mjs`

**Interfaces:**
- Consumes: Premultiplied front and rear styled/blurred RGBA images whose alpha excludes global Shadow Opacity.
- Produces: `combine_shadow_layers(front_texture:t0, rear_texture:t1, shadow_opacity:b0)`; output is premultiplied `front + rear * max(0,rear.a-front.a)/max(rear.a,1e-6)`, multiplied once by `shadow_opacity`. Existing `composite_shadow` remains the final object-over-shadow pass.

- [ ] **Step 1: Add a failing constant-result HLSL test for the combine equation.** Extract `combine_layer_colors` from the new shader and test:

```hlsl
float4 front = float4(.4, 0, 0, .4);
float4 rear = float4(0, 0, .5, .5);
float4 result = combine_layer_colors(front, rear, .5);
bool correct = all(abs(result - float4(.2, 0, .05, .25)) < 1e-5);
return correct ? float4(0,1,0,1) : float4(1,0,0,1);
```

The `.4` and `.5` input alpha values already include texture alpha. Add a second case with front alpha `1` and assert that rear RGB and alpha contribute zero. Use the existing green-output assembly assertion.
- [ ] **Step 2: Run `node --test tests/composite-shadow.test.mjs`; confirm failures are for the absent combine shader, not syntax.**
- [ ] **Step 3: Add `combine_shadow_layers` to `LongShadowN.anm2`.** Use this pure helper and integer pixel loads in the entry point; do not sample the source object here.

```hlsl
Texture2D front_texture : register(t0);
Texture2D rear_texture : register(t1);
cbuffer constant0 : register(b0) {
    float shadow_opacity;
};
float4 combine_layer_colors(float4 front, float4 rear, float opacity) {
    float rear_weight = max(0, rear.a - front.a) / max(rear.a, 1e-6);
    return (front + rear * rear_weight) * opacity;
}
float4 combine_shadow_layers(float4 pos : SV_Position) : SV_Target {
    return combine_layer_colors(front_texture[int2(pos.xy)],
        rear_texture[int2(pos.xy)], shadow_opacity);
}
```
- [ ] **Step 4: Parameterize `style_and_filter_shadow` with an explicit opacity value.** Replace the current shader-constant expression in both texture-repeat branches:

```lua
local function style_and_filter_shadow(buffer_w, buffer_h, work_scale,
    target_scale, refine_sample_count, refine_samples,
    direct_quality_step, opacity_value, layer_selector)
-- In each style_shadow constant list, use opacity_value where
-- shadow_opacity / 100 is currently passed.
```

The baseline caller passes `shadow_opacity / 100`; layered calls pass `1`. Do not change texture-alpha or source-color mixing formulas. This keeps global opacity out of each layer until combination.
- [ ] **Step 5: Run `node --test tests/composite-shadow.test.mjs`; expect all tests and embedded-shader compilation to pass.**
- [ ] **Step 6: Commit only Task 2 changes after inspecting the staged diff.**

### Task 3: Route Directional blur through the two-layer pipeline

**Files:**
- Modify: `LongShadowN.anm2` (Lua render dispatch and scratch-buffer lifecycle)
- Modify: `tests/composite-shadow.test.mjs`

**Interfaces:**
- Consumes: Task 1's `layer_selector` and Task 2's `combine_shadow_layers` plus the existing serial `style_and_filter_shadow` function.
- Produces: `render_direct_shadow(..., layer_selector)` and `style_and_filter_shadow(..., opacity_value, layer_selector)` calls wired so Directional with `blur_shadow > 0` renders front then rear, stores the front final image, combines it with the rear, and leaves the result in `cache:longshadown_final` for the unchanged `composite_shadow` call.

- [ ] **Step 1: Add failing dispatch tests.** Extract the final `if should_render_shadow then` Lua block and assert these routing tokens:

```js
assert.match(renderBlock, /shadow_type == 0 and blur_shadow > 0/);
assert.match(renderBlock, /for layer = 0, 1 do/);
assert.match(renderBlock, /combine_shadow_layers/);
assert.match(renderBlock, /work_scale, -1\)/);
assert.match(source, /"layer_front"/);
```

Also assert the no-shadow branch clears the final buffer. These source checks cover the Lua wiring; the Task 1/2 constant-result HLSL tests cover math, and manual Task 4 covers actual pixels. Keep the existing renderer-matrix tests green.
- [ ] **Step 2: Run `node --test tests/composite-shadow.test.mjs`; confirm the new routing tests fail because the two-layer branch is absent.**
- [ ] **Step 3: Extend `render_direct_shadow` and `style_and_filter_shadow` parameters and calls.** Append the selector to both shader constant lists; pass `-1` for the old path. The routing skeleton is:

```lua
if shadow_type == 0 and blur_shadow > 0 then
    for layer = 0, 1 do
        local target_scale, count, step = render_direct_shadow(
            work_w, work_h, source_pos_x, source_pos_y, work_scale, layer)
        style_and_filter_shadow(obj.w, obj.h, work_scale,
            target_scale, count, refine_samples, step, 1, layer)
        if layer == 0 then
            obj.copybuffer("cache:longshadown_layer_front", "cache:longshadown_final")
        end
    end
    obj.pixelshader("combine_shadow_layers", "cache:longshadown_filtered",
        { "cache:longshadown_layer_front", "cache:longshadown_final" },
        { shadow_opacity / 100 }, "copy", "clamp")
    obj.copybuffer("cache:longshadown_final", "cache:longshadown_filtered")
else
    local target_scale, count, step = render_direct_shadow(
        work_w, work_h, source_pos_x, source_pos_y, work_scale, -1)
    style_and_filter_shadow(obj.w, obj.h, work_scale,
        target_scale, count, refine_samples, step, shadow_opacity / 100, -1)
end
```

Add `layer_front` to the current-frame scratch reset list. The existing final `composite_shadow` call is unchanged. Keep `cache:longshadown_filtered` as a distinct combine destination so the rear image is not read from and written to the same buffer.
- [ ] **Step 4: Run `node --test tests/composite-shadow.test.mjs` and then `node --test`; expect all tests and shaders to pass. Run `git diff --check`.**
- [ ] **Step 5: Commit only Task 3 changes after inspecting the staged diff.** Do not stage unrelated `README.md` or pre-existing worktree modifications.

### Task 4: Compare the experiment and decide whether to keep or revert it

**Files:**
- Modify if evidence requires it: `LongShadowN.anm2`, `tests/composite-shadow.test.mjs`
- Record findings in: `docs/superpowers/specs/2026-09-23-directional-layered-blur-design.md`

**Interfaces:**
- Consumes: Task 3 build and the user's AviUtl2 reproduction scene.
- Produces: A reported before/after visual result and Standard/Ultra relative render-time observation. No Radial or Inverse Radial adoption in this task.

- [ ] **Step 1: Compare the user's Directional scene at Fade 50 and Blur Shadow 40, concentrating on the circled glyph holes and root wedges.** Also inspect Blur 0, Blur 10/80, all four quality levels, and Object Opacity 0/50/100. If this environment cannot operate AviUtl2 or the scene is unavailable, ask the user for screenshots; do not claim visual success from shader compilation.
- [ ] **Step 2: Compare interactive or frame render time at Standard and Ultra with Blur 40 against the pre-change build, and report relative cost.** If the cost is unacceptable or the wedge remains, stop before extending the algorithm. Preserve the known-good source and report the failed hypothesis; do not stack another speculative fix.
- [ ] **Step 3: Re-run `node --test` and `git diff --check` after any evidence-driven correction.** If code changes, add a failing regression test before the correction and commit only that task's files.
