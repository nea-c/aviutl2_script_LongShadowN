# Continuous Object and Shadow Compositing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace binary object-edge backing with continuous premultiplied compositing so source AA, Object Opacity zero, and extended shadows coexist without fringes.

**Architecture:** The final compositor will use the original source alpha as a continuous overlap mask. A single helper will reject distance-zero coverage outside the source, attenuate shadow under the source according to Object Opacity, and leave positive-distance extension intact; the styled source is then composited with normal premultiplied source-over.

**Tech Stack:** AviUtl2 `.anm2` Lua script, embedded HLSL pixel shaders, Node.js `node:test`, Microsoft FXC Shader Model 5 compiler.

**Spec:** `docs/superpowers/specs/2026-09-23-continuous-object-shadow-compositing-design.md`

## Global Constraints

- Do not add a render pass, texture buffer, user-facing parameter, or saved-project value.
- Keep Directional, Radial, and Inverse Radial renderer routing unchanged.
- Keep Fade, texture, Blur Shadow, Post Smooth, supersampling, and padding behavior unchanged.
- Use premultiplied RGBA throughout the compositor.
- Object Opacity zero removes fully covered overlap, antialiases partial overlap, and preserves positive-distance extension.
- Remove the one-byte `saturate(source.a * 255)` backing mask and do not replace it with another binary source-alpha threshold.

## Review Focus

- Source alpha below `1/255`: it remains proportional instead of becoming full support; Task 1 Step 1 includes `1/1024` coverage.
- Intermediate Object Opacity: both source and overlapping shadow change continuously; Task 1 Step 1 includes opacity `0.5`.
- Partially transparent shadow: premultiplied RGB and alpha remain bounded and proportional; Task 1 Step 1 includes shadow alpha `0.5`.
- Near-root positive distance: `1e-5` extension is retained while exact distance zero outside the source is removed; Task 1 Step 1 includes both values.
- Object Mix at a partial source edge: only the source contribution is recolored and the background shadow remains visible; Task 1 Step 1 includes a red source over a blue shadow.

---

### Task 1: Continuous final compositing

**Files:**
- Modify: `LongShadowN.anm2:823-870` — final HLSL compositor helpers and entry point.
- Modify: `tests/composite-shadow.test.mjs:613-735` — constant-folded HLSL behavior tests.

**Interfaces:**
- Consumes: `float4 shadow`, original premultiplied `float4 source`, resolved packed `float4 shadow_info`, and global normalized `float object_opacity`.
- Produces: `float4 prepare_shadow_for_object(float4 shadow, float4 source, float4 shadow_info)`, returning premultiplied shadow ready for standard source-over.
- Retains: `float4 color_object(float4 source)` and `float4 composite_shadow(float4 pos : SV_Position)`.
- Removes: `float4 neutralize_shadow(float4 shadow, float4 source)` and its binary one-byte support behavior.

- [ ] **Step 1: Replace the old backing expectations with failing continuous-compositing tests**

In `tests/composite-shadow.test.mjs`, keep the existing `extractFunction` and
`compileConstantResult` helpers. Replace the tests beginning with
`zero-distance Direct coverage is hidden outside the source` through
`object mix is not diluted by the original-colored shadow` with tests that
extract `prepare_shadow_for_object` and `color_object` and compile literal
cases.

The first test pins root rejection without deleting real extension:

```js
test("only exact unextended coverage is hidden outside the source", () => {
  const source = readFileSync(scriptPath, "utf8");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  const assembly = compileConstantResult(`
static const float object_opacity = 1;
${prepareShadow}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 shadow = float4(0, 0, 0.5, 0.5);
    float4 transparent_source = 0;
    float4 root_info = float4(0.25, 0, 1, 0.5);
    float4 near_info = float4(0.25, 0.000005, 1, 0.5);
    float4 removed = prepare_shadow_for_object(
        shadow, transparent_source, root_info);
    float4 retained = prepare_shadow_for_object(
        shadow, transparent_source, near_info);
    bool correct = all(abs(removed) < 1e-6)
        && all(abs(retained - shadow) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "root rejection removed positive-distance extension or retained distance zero");
});
```

`near_info.g / near_info.a` is `1e-5`, deliberately above the exact-root
threshold.

The second test pins normal source-over at full Object Opacity:

```js
test("shadow overlap preserves continuous source antialiasing", () => {
  const source = readFileSync(scriptPath, "utf8");
  const colorObject = extractFunction(source, "color_object");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  const assembly = compileConstantResult(`
static const float3 object_rgb = float3(1, 0, 0);
static const float object_mix = 0;
static const float object_opacity = 1;
${colorObject}
${prepareShadow}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 original = float4(0.5, 0.5, 0.5, 0.5);
    float4 blue_shadow = float4(0, 0, 1, 1);
    float4 info = float4(0.25, 0.25, 1, 1);
    float4 shadow = prepare_shadow_for_object(blue_shadow, original, info);
    float4 styled = color_object(original);
    float4 result = styled + shadow * (1 - styled.a);
    float4 no_shadow = prepare_shadow_for_object(
        float4(0, 0, 0, 0), original, float4(0, 0, 0, 0));
    float4 transparent_result = styled + no_shadow * (1 - styled.a);
    bool correct = all(abs(result - float4(0.5, 0.5, 1, 1)) < 1e-6)
        && all(abs(transparent_result - original) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "source edge was normalized to an opaque object-colored backing");
});
```

Add this table-style constant shader test for Object Opacity endpoints,
intermediate opacity, tiny source alpha, and partial shadow alpha:

```js
test("Object Opacity attenuates overlap with continuous source coverage", () => {
  const source = readFileSync(scriptPath, "utf8");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  const cases = [
    {
      name: "zero opacity and full source",
      opacity: "0",
      sourceValue: "float4(1, 1, 1, 1)",
      expected: "float4(0, 0, 0, 0)",
    },
    {
      name: "zero opacity and half source",
      opacity: "0",
      sourceValue: "float4(0.5, 0.5, 0.5, 0.5)",
      expected: "float4(0, 0, 0.25, 0.25)",
    },
    {
      name: "half opacity and half source",
      opacity: "0.5",
      sourceValue: "float4(0.5, 0.5, 0.5, 0.5)",
      expected: "float4(0, 0, 0.375, 0.375)",
    },
    {
      name: "full opacity and sub-byte source",
      opacity: "1",
      sourceValue: "float4(1.0 / 1024, 1.0 / 1024, 1.0 / 1024, 1.0 / 1024)",
      expected: "float4(0, 0, 0.5, 0.5)",
    },
  ];
  for (const testCase of cases) {
    const assembly = compileConstantResult(`
static const float object_opacity = ${testCase.opacity};
${prepareShadow}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 shadow = float4(0, 0, 0.5, 0.5);
    float4 source_sample = ${testCase.sourceValue};
    float4 info = float4(0.25, 0.125, 1, 0.5);
    float4 result = prepare_shadow_for_object(shadow, source_sample, info);
    bool correct = all(abs(result - ${testCase.expected}) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      testCase.name);
  }
});
```

Finally, replace the old Object Mix full-red expectation with the physically
correct partial-edge result using this complete test:

```js
test("Object Mix recolors only the antialiased source contribution", () => {
  const source = readFileSync(scriptPath, "utf8");
  const colorObject = extractFunction(source, "color_object");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  const assembly = compileConstantResult(`
static const float3 object_rgb = float3(1, 0, 0);
static const float object_mix = 1;
static const float object_opacity = 1;
${colorObject}
${prepareShadow}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 original = float4(0.5, 0.5, 0.5, 0.5);
    float4 blue_shadow = float4(0, 0, 1, 1);
    float4 info = float4(0.25, 0.25, 1, 1);
    float4 prepared = prepare_shadow_for_object(blue_shadow, original, info);
    float4 styled = color_object(original);
    float4 result = styled + prepared * (1 - styled.a);
    bool correct = all(abs(result - float4(0.5, 0, 0.5, 1)) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "Object Mix normalized a partial edge or recolored the background shadow");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="unextended coverage|continuous source antialiasing|Object Opacity attenuates|Object Mix" tests/composite-shadow.test.mjs
```

Expected: FAIL because `prepare_shadow_for_object was not found`, or because
the current binary backing produces the old opaque values. A syntax error or an
FXC invocation error is not the expected RED; fix the test and rerun until the
failure names the missing continuous behavior.

- [ ] **Step 3: Implement the continuous shadow-preparation helper**

In the embedded `composite_shadow` shader in `LongShadowN.anm2`, replace
`remove_unextended_shadow` and `neutralize_shadow` with:

```hlsl
float4 prepare_shadow_for_object(float4 shadow, float4 source,
    float4 shadow_info) {
    if (shadow_info.a > 1e-6 && source.a <= 1e-6) {
        float distance = saturate(shadow_info.g / shadow_info.a);
        if (distance <= 1e-6) return 0;
    }
    float overlap_weight = 1 - source.a * (1 - object_opacity);
    return shadow * overlap_weight;
}
```

Do not use `saturate(source.a * 255)`, nearest-neighbor dilation, or an
object-colored backing.

- [ ] **Step 4: Wire standard premultiplied source-over**

Update `composite_shadow` to prepare the shadow once, style the source once, and
perform normal source-over:

```hlsl
float4 composite_shadow(float4 pos : SV_Position) : SV_Target {
    float4 shadow = shadow_texture[int2(pos.xy)];
    float4 shadow_info = shadow_info_texture[int2(pos.xy)];
    int2 source_pos = int2(floor(pos.xy - source_offset));
    float4 source_sample = 0;
    if (all(source_pos >= 0) && all(source_pos < int2(source_size))) {
        source_sample = source_texture[source_pos];
    }
    shadow = prepare_shadow_for_object(shadow, source_sample, shadow_info);
    float4 source = color_object(source_sample);
    return source + shadow * (1 - source.a);
}
```

Keep the existing third input texture,
`cache:longshadown_resolved`, in the Lua `obj.pixelshader` call.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="unextended coverage|continuous source antialiasing|Object Opacity attenuates|Object Mix|all embedded pixel shaders compile" tests/composite-shadow.test.mjs
```

Expected: all selected tests PASS and every embedded HLSL shader compiles.

- [ ] **Step 6: Run the full automated regression suite**

Run:

```powershell
node --test tests/*.test.mjs
git diff --check
```

Expected: all tests PASS, HLSL compilation succeeds, and `git diff --check`
returns no errors. The existing FXC `X3577` warning about `isfinite()` is
known and does not indicate failure.

- [ ] **Step 7: Inspect the final diff against the spec**

Run:

```powershell
git diff -- LongShadowN.anm2 tests/composite-shadow.test.mjs
rg -n "source\.a \* 255|neutralize_shadow|prepare_shadow_for_object|overlap_weight" LongShadowN.anm2 tests/composite-shadow.test.mjs
```

Expected:

- no `source.a * 255` or `neutralize_shadow` remains;
- one `prepare_shadow_for_object` definition and one compositor call remain;
- `overlap_weight` uses continuous source alpha and Object Opacity;
- no renderer, blur, fade, texture, or parameter definitions changed.

- [ ] **Step 8: Commit the implementation**

```powershell
git add -- LongShadowN.anm2 tests/composite-shadow.test.mjs
git commit -m "Use continuous object shadow compositing"
```

- [ ] **Step 9: Perform manual AviUtl verification before integration**

Use a white antialiased glyph over a saturated shadow and check Object Opacity
at `100`, `50`, and `0` for Directional, Radial, and Inverse Radial. Inspect the
shadow-facing outer edge, the opposite edge, and glyph holes at 400% or higher
preview zoom.

Acceptance criteria:

- no white/object-colored binary fringe where source and shadow overlap;
- no black gap on the shadow-facing edge;
- no colored distance-zero outline on the non-extending edge;
- Object Opacity `0` removes the fully covered overlap and leaves an
  antialiased transition into the positive-distance shadow;
- extended shadow remains visible and no quality tier routing changes.
