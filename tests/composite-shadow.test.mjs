import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const scriptPath = resolve("LongShadowN.anm2");
const sdkBin = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
const fxcPath = process.env.FXC_PATH ?? readdirSync(sdkBin)
  .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
  .map((version) => join(sdkBin, version, "x64", "fxc.exe"))
  .find(existsSync);
assert.ok(fxcPath, "Set FXC_PATH or install the Windows SDK HLSL compiler");

function extractFunction(source, name, returnType = "float4") {
  const signature = `${returnType} ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${name} was not found`);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} has an unterminated body`);
}

function compileConstantResult(shaderSource) {
  const directory = mkdtempSync(join(tmpdir(), "longshadown-test-"));
  const sourcePath = join(directory, "test.hlsl");
  const objectPath = join(directory, "test.cso");
  const assemblyPath = join(directory, "test.asm");
  try {
    writeFileSync(sourcePath, shaderSource);
    execFileSync(fxcPath, [
      "/nologo", "/T", "ps_5_0", "/E", "testmain", "/O3",
      "/Fo", objectPath, "/Fc", assemblyPath, sourcePath,
    ]);
    return readFileSync(assemblyPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("all embedded pixel shaders compile", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shaders = [...source.matchAll(/--\[\[pixelshader@([^:]+):\s*([\s\S]*?)\]\]/g)];
  assert.ok(shaders.length > 0, "no embedded pixel shaders were found");

  const directory = mkdtempSync(join(tmpdir(), "longshadown-compile-"));
  try {
    for (const [, name, shaderSource] of shaders) {
      const sourcePath = join(directory, `${name}.hlsl`);
      const objectPath = join(directory, `${name}.cso`);
      writeFileSync(sourcePath, shaderSource);
      execFileSync(fxcPath, [
        "/nologo", "/T", "ps_5_0", "/E", name, "/O3",
        "/Fo", objectPath, sourcePath,
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("obsolete non-Direct shadow renderers are removed", () => {
  const source = readFileSync(scriptPath, "utf8");
  for (const name of [
    "seed_shadow",
    "directional_step",
    "raymarch_shadow",
    "inverse_raymarch_shadow",
    "radial_step",
    "smooth_distance",
  ]) {
    assert.doesNotMatch(source, new RegExp(`pixelshader@${name}:`));
  }
  for (const name of [
    "render_radial_scale",
    "render_inverse_direct",
    "render_ultra_raymarch",
    "render_fast_directional",
  ]) {
    assert.doesNotMatch(source, new RegExp(`local function ${name}`));
  }
  assert.match(source, /pixelshader@direct_raymarch_shadow:/);
  assert.match(source, /local function render_direct_shadow/);
});

test("direct interval helpers clip directional radial and inverse rays", () => {
  const source = readFileSync(scriptPath, "utf8");
  const clipAxis = extractFunction(source, "clip_parameter_axis", "bool");
  const pointInside = extractFunction(source, "point_inside_bounds", "bool");
  const nextParameter = extractFunction(source, "next_parameter_toward", "float");
  const finishInterval = extractFunction(source, "finish_clipped_interval", "bool");
  const directional = extractFunction(source, "directional_ray_interval", "bool");
  const projection = extractFunction(source, "projection_ray_interval", "bool");
  const distanceFromU = extractFunction(source, "projection_distance_from_u", "float");
  const assembly = compileConstantResult(`
${clipAxis}
${pointInside}
${nextParameter}
${finishInterval}
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
    float near_distance = projection_distance_from_u(1.0000001, .99999995);
    bool correct = dh && !dm && ds >= .5 && ds < .5001
        && abs(de - .75) < 1e-4 && abs(dspan - 1) < 1e-4
        && ih && is < ie && abs(ispan - .5) < 1e-3
        && rh && rs > re && abs(rspan - .1) < 1e-3
        && isfinite(near_distance) && near_distance >= 0 && near_distance <= 1;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("direct sampling includes both endpoints when capped", () => {
  const source = readFileSync(scriptPath, "utf8");
  const sampleParameter = extractFunction(source, "direct_sample_parameter", "float");
  const assembly = compileConstantResult(`
${sampleParameter}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float first = direct_sample_parameter(3, 9003, 0, 8001);
    float penultimate = direct_sample_parameter(3, 9003, 7999, 8001);
    float last = direct_sample_parameter(3, 9003, 8000, 8001);
    bool correct = first == 3 && last == 9003
        && penultimate < last && abs((last - first) / 8000 - 1.125) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("projection interval preserves boundary edge cases", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@direct_raymarch_shadow:\s*([\s\S]*?)\]\]/,
  );
  assert.ok(shader, "direct_raymarch_shadow shader was not found");
  const helpers = [
    extractFunction(shader[1], "clip_parameter_axis", "bool"),
    extractFunction(shader[1], "point_inside_bounds", "bool"),
    extractFunction(shader[1], "next_parameter_toward", "float"),
    extractFunction(shader[1], "finish_clipped_interval", "bool"),
    extractFunction(shader[1], "projection_ray_interval", "bool"),
  ].join("\n");
  const assembly = compileConstantResult(`
${helpers}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float ns, ne, nspan;
    bool narrow = projection_ray_interval(
        float2(1.5, .4999), float2(2.5, -.5001), .25,
        float2(0, 0), float2(1, 1), ns, ne, nspan);
    float2 narrow_first = float2(2.5, -.5001)
        + (float2(1.5, .4999) - float2(2.5, -.5001)) * ns;
    float2 narrow_last = float2(2.5, -.5001)
        + (float2(1.5, .4999) - float2(2.5, -.5001)) * ne;

    float ts, te, tspan;
    bool upper_tangent = projection_ray_interval(
        float2(1, 1), float2(2, 0), .25,
        float2(0, 0), float2(1, 1), ts, te, tspan);
    bool lower_tangent = projection_ray_interval(
        float2(-1, 1), float2(-2, 2), .25,
        float2(0, 0), float2(1, 1), ts, te, tspan);

    float ws, we, wspan;
    float2 wide_origin = float2(-3.7, -4);
    float2 wide_pixel = float2(-2.1, -2.3);
    bool wide = projection_ray_interval(wide_pixel, wide_origin, .25,
        float2(0, 0), float2(1, 1), ws, we, wspan);
    float2 wide_first = wide_origin + (wide_pixel - wide_origin) * ws;
    float2 wide_last = wide_origin + (wide_pixel - wide_origin) * we;

    float cs, ce, cspan;
    bool convergence = projection_ray_interval(
        float2(.5, 0), float2(0, 0), .25,
        float2(-1, -1), float2(3, 1), cs, ce, cspan);

    bool correct = narrow
        && all(narrow_first >= 0) && all(narrow_first < 1)
        && all(narrow_last >= 0) && all(narrow_last < 1)
        && !upper_tangent && !lower_tangent
        && wide && wspan > 1.3 && wspan < 1.4
        && all(wide_first >= 0) && all(wide_first < 1)
        && all(wide_last >= 0) && all(wide_last < 1)
        && convergence && abs(ce - 4) < 1e-5;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("endpoint adjustment is constant time in both Direct traversals", () => {
  const source = readFileSync(scriptPath, "utf8");
  for (const shaderName of ["direct_raymarch_shadow", "edge_antialias"]) {
    const shader = source.match(
      new RegExp(`--\\[\\[pixelshader@${shaderName}:\\s*([\\s\\S]*?)\\]\\]`),
    );
    assert.ok(shader, `${shaderName} shader was not found`);
    const nudge = extractFunction(shader[1], "next_parameter_toward", "float");
    const finish = extractFunction(shader[1], "finish_clipped_interval", "bool");
    assert.match(nudge, /8192/);
    assert.doesNotMatch(nudge, /asuint\(|asfloat\(/);
    assert.doesNotMatch(finish, /\bfor\s*\(/);
    assert.match(finish, /next_parameter_toward\(/);
  }
});

test("projection clipping survives large-coordinate cancellation", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@direct_raymarch_shadow:\s*([\s\S]*?)\]\]/,
  );
  assert.ok(shader, "direct_raymarch_shadow shader was not found");
  const helpers = [
    extractFunction(shader[1], "clip_parameter_axis", "bool"),
    extractFunction(shader[1], "point_inside_bounds", "bool"),
    extractFunction(shader[1], "next_parameter_toward", "float"),
    extractFunction(shader[1], "finish_clipped_interval", "bool"),
    extractFunction(shader[1], "projection_ray_interval", "bool"),
  ].join("\n");
  const assembly = compileConstantResult(`
${helpers}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_u, end_u, source_span;
    float2 origin = float2(1460.82177734375, 1500);
    float2 pixel = float2(1712.49462890625, 1500);
    float2 bounds_min = float2(1443.54833984375, 1000);
    float2 bounds_max = float2(2097.79931640625, 2000);
    bool hit = projection_ray_interval(pixel, origin, .25,
        bounds_min, bounds_max, start_u, end_u, source_span);
    float2 first = origin + (pixel - origin) * start_u;
    float2 last = origin + (pixel - origin) * end_u;
    bool correct = hit
        && all(first >= bounds_min) && all(first < bounds_max)
        && all(last >= bounds_min) && all(last < bounds_max)
        && source_span > 0;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("Direct shader and Lua renderer share the packed source contract", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@direct_raymarch_shadow:\s*([\s\S]*?)\]\]/,
  );
  assert.ok(shader, "direct_raymarch_shadow shader was not found");
  assert.match(shader[1], /Texture2D source_texture : register\(t0\)/);
  assert.match(
    shader[1],
    /return float4\(selected_source_coordinate\.x, weighted_distance,\s*selected_source_coordinate\.y, coverage\)/,
  );
  assert.match(
    shader[1],
    /source_pixel = projection_origin\s*\+ \(pixel - projection_origin\) \* parameter/,
  );
  assert.match(
    shader[1],
    /distance = projection_distance_from_u\(target_scale, parameter\)/,
  );

  const renderer = source.match(
    /local function render_direct_shadow\([\s\S]*?\r?\nend/,
  );
  assert.ok(renderer, "render_direct_shadow was not found");
  assert.match(renderer[0], /obj\.pixelshader\("direct_raymarch_shadow"/);
  assert.match(renderer[0], /return target_scale, refine_sample_count, quality_step/);
});

test("Direct quality spacing remains 4 2 1 and 0.5 source pixels", () => {
  const source = readFileSync(scriptPath, "utf8");
  const qualityConfig = source.match(
    /local function get_quality_config\(level\)([\s\S]*?)\r?\nend/,
  );
  assert.ok(qualityConfig, "get_quality_config was not found");
  assert.match(qualityConfig[1], /\[0\] = \{ sample_step = 4\.0,/);
  assert.match(qualityConfig[1], /\[1\] = \{ sample_step = 2\.0,/);
  assert.match(qualityConfig[1], /\[2\] = \{ sample_step = 1\.0,/);
  assert.match(qualityConfig[1], /\[3\] = \{ sample_step = 0\.5,/);

  const renderer = source.match(
    /local function render_direct_shadow\([\s\S]*?\r?\nend/,
  );
  assert.ok(renderer, "render_direct_shadow was not found");
  assert.match(
    renderer[0],
    /math\.ceil\(effective_length \* work_scale \/ quality_step\) \+ 1/,
  );
  assert.match(renderer[0], /math\.min\(MAX_DIRECT_SAMPLES,/);
});

test("Lua direct renderer and routing match the approved matrix", () => {
  const source = readFileSync(scriptPath, "utf8");
  const renderer = source.match(
    /local function render_direct_shadow\([\s\S]*?\r?\nend/,
  );
  assert.ok(renderer, "render_direct_shadow was not found");
  assert.match(renderer[0], /local target_scale, effective_length = 1, shadow_length/);
  assert.match(renderer[0], /if shadow_type >= 1 then[\s\S]*?get_radial_projection/);
  assert.match(renderer[0], /obj\.pixelshader\("direct_raymarch_shadow"/);
  assert.match(renderer[0], /return target_scale, refine_sample_count, quality_step/);

  const dispatch = source.match(
    /if should_render_shadow then[\s\S]*?\r?\nelse/,
  );
  assert.ok(dispatch, "shadow renderer dispatch was not found");
  assert.match(dispatch[0], /render_direct_shadow/);
  assert.doesNotMatch(
    dispatch[0],
    /render_fast_directional|render_ultra_raymarch|render_radial_scale|render_inverse_direct/,
  );
});

test("edge Direct helpers keep projection order endpoints and misses", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@edge_antialias:\s*([\s\S]*?)\]\]/,
  );
  assert.ok(shader, "edge_antialias shader was not found");
  const clipAxis = extractFunction(shader[1], "clip_parameter_axis", "bool");
  const pointInside = extractFunction(shader[1], "point_inside_bounds", "bool");
  const nextParameter = extractFunction(shader[1], "next_parameter_toward", "float");
  const finishInterval = extractFunction(shader[1], "finish_clipped_interval", "bool");
  const projectionInterval = extractFunction(shader[1], "projection_ray_interval", "bool");
  const distanceFromU = extractFunction(shader[1], "projection_distance_from_u", "float");
  const sampleParameter = extractFunction(shader[1], "direct_sample_parameter", "float");
  const assembly = compileConstantResult(`
${clipAxis}
${pointInside}
${nextParameter}
${finishInterval}
${projectionInterval}
${distanceFromU}
${sampleParameter}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_u, end_u, source_span;
    bool hit = projection_ray_interval(float2(.5, 0), float2(0, 0), .25,
        float2(-1, -1), float2(1, 1), start_u, end_u, source_span);
    float miss_start, miss_end, miss_span;
    bool miss = projection_ray_interval(float2(2, 0), float2(0, 0), .25,
        float2(-2, -1), float2(-1, 1), miss_start, miss_end, miss_span);
    float radial_start, radial_end, radial_span;
    bool radial = projection_ray_interval(float2(.5, 0), float2(0, 0), 2,
        float2(.3, -1), float2(.4, 1),
        radial_start, radial_end, radial_span);
    float exact_end = direct_sample_parameter(start_u, end_u, 8000, 8001);
    bool correct = hit && !miss
        && start_u < end_u && abs(source_span - .5) < 1e-3
        && radial && radial_start > radial_end && abs(radial_span - .1) < 1e-3
        && exact_end == end_u
        && projection_distance_from_u(.25, start_u)
            < projection_distance_from_u(.25, end_u);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );

});

test("edge refinement mirrors generalized Direct traversal", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@edge_antialias:\s*([\s\S]*?)\]\]/,
  );
  assert.ok(shader, "edge_antialias shader was not found");
  assert.match(shader[1], /float direct_quality_step;/);
  assert.match(shader[1], /bool directional_ray_interval\(/);
  assert.match(shader[1], /bool projection_ray_interval\(/);
  assert.match(shader[1], /if \(direct_quality_step > 0\)/);
  assert.match(
    shader[1],
    /ceil\(source_span \* work_scale\s*\/ direct_quality_step\) \+ 1/,
  );
  assert.match(
    shader[1],
    /direct_sample_parameter\(\s*start_parameter, end_parameter,/,
  );
  assert.doesNotMatch(
    shader[1],
    /inverse_quality_step|inverse_ray_interval|inverse_sample_u/,
  );

  const style = source.match(
    /local function style_and_filter_shadow\([\s\S]*?\r?\nend/,
  );
  assert.ok(style, "style_and_filter_shadow was not found");
  assert.match(
    style[0],
    /target_scale, refine_sample_count, refine_samples, direct_quality_step,\s*opacity_value, layer_selector\)/,
  );
  assert.match(style[0], /direct_quality_step = direct_quality_step or 0/);
  assert.match(
    style[0],
    /fade_in \/ 100, fade_out \/ 100[\s\S]*?direct_quality_step, work_scale/,
  );
});

test("fade controls expose percent values while shaders receive normalized values", () => {
  const source = readFileSync(scriptPath, "utf8");
  const readTrack = (name) => {
    const match = source.match(new RegExp(
      `^--track@${name}:[^,]+,(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?),`,
      "m",
    ));
    assert.ok(match, `${name} track was not found`);
    return match.slice(1).map(Number);
  };

  assert.deepEqual(readTrack("fade_in"), [0, 100, 100]);
  assert.deepEqual(readTrack("fade_out"), [0, 100, 50]);

  const directCall = source.match(
    /obj\.pixelshader\("direct_raymarch_shadow"[\s\S]*?quality_step, work_scale,\s*([^,]+), ([^,}]+), layer_selector \}/,
  );
  assert.ok(directCall, "direct_raymarch_shadow call was not found");
  const antialiasCall = source.match(
    /obj\.pixelshader\("edge_antialias"[\s\S]*?refine_samples,\s*([^,]+), ([^,]+), effective_quality/,
  );
  assert.ok(antialiasCall, "edge_antialias call was not found");
  const evaluate = (expression, fadeIn, fadeOut) => Function(
    "fade_in", "fade_out", `return ${expression};`,
  )(fadeIn, fadeOut);
  assert.equal(evaluate(directCall[1], 100, 50), 1);
  assert.equal(evaluate(directCall[2], 100, 50), 0.5);
  assert.equal(evaluate(antialiasCall[1], 100, 50), 1);
  assert.equal(evaluate(antialiasCall[2], 100, 50), 0.5);
});

test("blur shadow exposes a 4000 px range in 0.1 px steps", () => {
  const source = readFileSync(scriptPath, "utf8");
  const match = source.match(
    /^--track@blur_shadow:[^,]+,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/m,
  );
  assert.ok(match, "Blur Shadow track was not found");

  assert.deepEqual(match.slice(1).map(Number), [0, 4000, 0, 0.1]);
});

test("blur sampling keeps at most 3.125 px spacing throughout the upper range", () => {
  const source = readFileSync(scriptPath, "utf8");
  const blurHalfSamples = extractFunction(source, "blur_half_samples", "int");
  const assembly = compileConstantResult(`
${blurHalfSamples}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    int samples_at_50 = blur_half_samples(50);
    int samples_at_102 = blur_half_samples(102);
    int samples_at_150 = blur_half_samples(150);
    int samples_at_200 = blur_half_samples(200);
    bool correct = samples_at_50 == 16
        && samples_at_102 == 33
        && samples_at_150 == 48
        && samples_at_200 == 64
        && 50.0 / samples_at_50 <= 3.125
        && 102.0 / samples_at_102 <= 3.125
        && 150.0 / samples_at_150 <= 3.125
        && 200.0 / samples_at_200 <= 3.125;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);

  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "blur samples became sparse enough to reveal banding",
  );
});

test("distance support feathers to zero instead of creating hard fragments", () => {
  const source = readFileSync(scriptPath, "utf8");
  const distanceBlurRadius = extractFunction(source, "distance_blur_radius", "float");
  const spreadDistanceCandidate = extractFunction(
    source, "spread_distance_candidate", "float",
  );
  const assembly = compileConstantResult(`
${distanceBlurRadius}
${spreadDistanceCandidate}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float inside = spread_distance_candidate(1, 100, 100, 3.125);
    float feather = spread_distance_candidate(1, 101.5625, 100, 3.125);
    float outside = spread_distance_candidate(1, 103.125, 100, 3.125);
    bool correct = abs(inside - 1) < 1e-6
        && abs(feather - 0.5) < 1e-6
        && abs(outside) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);

  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "distance support ended with a hard boundary",
  );
});

test("color blur uses one center radius and normalizes transparent edge samples", () => {
  const source = readFileSync(scriptPath, "utf8");
  const blurShader = source.match(/--\[\[pixelshader@blur_shadow:([\s\S]*?)\]\]/);
  assert.ok(blurShader, "blur_shadow shader was not found");
  const body = extractFunction(blurShader[1], "blur_shadow");
  const loop = body.match(/\[loop\]([\s\S]*?)return/);
  assert.ok(loop, "blur loop was not found");

  assert.doesNotMatch(loop[1], /distance_texture\.SampleLevel/);
  assert.doesNotMatch(loop[1], /occupied/);
  assert.match(loop[1], /sum \+= styled_texture\.SampleLevel[^;]+\* weight;\s*weight_sum \+= weight;/);
});

test("blur radius grows linearly from the shadow root to its tip", () => {
  const source = readFileSync(scriptPath, "utf8");
  const distanceBlurRadius = extractFunction(source, "distance_blur_radius", "float");
  const assembly = compileConstantResult(`
${distanceBlurRadius}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    bool correct = abs(distance_blur_radius(0, 20) - 0) < 1e-6
        && abs(distance_blur_radius(0.5, 20) - 10) < 1e-6
        && abs(distance_blur_radius(1, 20) - 20) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);

  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "blur radius did not grow linearly with normalized shadow distance",
  );
});

test("distance blur samples enter the kernel with continuous weight", () => {
  const source = readFileSync(scriptPath, "utf8");
  const distanceBlurWeight = extractFunction(source, "distance_blur_weight", "float");
  const assembly = compileConstantResult(`
${distanceBlurWeight}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    bool correct = abs(distance_blur_weight(3.125, 0, 3.125) - 0) < 1e-6
        && abs(distance_blur_weight(3.125, 1.5625, 3.125) - 1.5625) < 1e-6
        && abs(distance_blur_weight(3.125, 3.125, 3.125) - 3.125) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);

  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "distance blur sample weights changed discontinuously at a sample boundary",
  );
});

test("distance field is smoothed in both axes before either color blur pass", () => {
  const source = readFileSync(scriptPath, "utf8");
  const blurPipeline = source.match(/if blur_shadow > 0 then([\s\S]*?)\r?\n    end\r?\nend/);
  assert.ok(blurPipeline, "blur pipeline was not found");

  const horizontalDistance = blurPipeline[1].match(
    /"spread_blur_distance", "cache:longshadown_blur_distance_a",\s*"cache:longshadown_resolved",\s*\{ buffer_w, buffer_h, 1, 0, blur_shadow \}/,
  );
  const verticalDistance = blurPipeline[1].match(
    /"spread_blur_distance", "cache:longshadown_blur_distance_b",\s*"cache:longshadown_blur_distance_a",\s*\{ buffer_w, buffer_h, 0, 1, blur_shadow \}/,
  );
  assert.ok(horizontalDistance, "horizontal distance smoothing pass was not found");
  assert.ok(verticalDistance, "vertical distance smoothing pass was not found");

  const colorPasses = [...blurPipeline[1].matchAll(
    /"blur_shadow"[\s\S]*?\{ "cache:longshadown_[^"]+", "([^"]+)" \}/g,
  )];
  assert.equal(colorPasses.length, 2);
  assert.deepEqual(
    colorPasses.map((match) => match[1]),
    ["cache:longshadown_blur_distance_b", "cache:longshadown_blur_distance_b"],
  );
});

test("correlated coverage difference removes only the shared root", () => {
  const source = readFileSync(scriptPath, "utf8");
  for (const shaderName of ["direct_raymarch_shadow", "edge_antialias"]) {
    const shader = source.match(
      new RegExp(`--\\[\\[pixelshader@${shaderName}:([\\s\\S]*?)\\]\\]`),
    )?.[1];
    assert.ok(shader, `${shaderName} shader was not found`);
    const difference = extractFunction(
      shader, "shadow_only_coverage", "float");
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
      `${shaderName} retained correlated root coverage`);
  }
});

test("fade is accumulated per ray sample without first-hit discontinuities", () => {
  const source = readFileSync(scriptPath, "utf8");
  for (const shaderName of ["direct_raymarch_shadow", "edge_antialias"]) {
    const shader = source.match(
      new RegExp(`--\\[\\[pixelshader@${shaderName}:([\\s\\S]*?)\\]\\]`),
    )?.[1];
    assert.ok(shader, `${shaderName} shader was not found`);
    const union = extractFunction(shader, "union_coverage", "float");
    const difference = extractFunction(
      shader, "shadow_only_coverage", "float");
    const conditional = extractFunction(
      shader, "conditional_shadow_coverage", "float");
    const fade = extractFunction(shader, "fade_weight_sample", "float");
    const accumulate = extractFunction(
      shader, "accumulate_faded_shadow_sample", "bool");
    const assembly = compileConstantResult(`
static const float fade_in = 0;
static const float fade_out = 0;
${union}
${difference}
${conditional}
${fade}
${accumulate}
float2 accumulate_forward() {
    float coverage = 0;
    float weighted_distance = 0;
    accumulate_faded_shadow_sample(0.1, 0, 0.25,
        coverage, weighted_distance);
    accumulate_faded_shadow_sample(1.0, 0, 0.75,
        coverage, weighted_distance);
    return float2(coverage, weighted_distance);
}
float2 accumulate_reverse() {
    float coverage = 0;
    float weighted_distance = 0;
    accumulate_faded_shadow_sample(1.0, 0, 0.75,
        coverage, weighted_distance);
    accumulate_faded_shadow_sample(0.1, 0, 0.25,
        coverage, weighted_distance);
    return float2(coverage, weighted_distance);
}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float2 forward = accumulate_forward();
    float2 reverse = accumulate_reverse();
    bool correct = all(abs(forward - float2(0.84375, 0.625)) < 1e-6)
        && all(abs(reverse - float2(0.84375, 0.6328125)) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      `${shaderName} let a weak first hit choose Fade for a stronger later hit`);
    assert.doesNotMatch(shader, /first_distance/,
      `${shaderName} still applies one first-hit Fade weight to the whole ray`);
  }
});

test("layered Direct samples retain ordered intervals and raw rear coverage", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(/--\[\[pixelshader@direct_raymarch_shadow:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader);
  const state = shader.match(/struct LayeredSampleState\s*\{[\s\S]*?\};/)?.[0];
  assert.ok(state, "LayeredSampleState was not found");
  const conditional = extractFunction(shader, "conditional_shadow_coverage", "float");
  const shadowOnly = extractFunction(shader, "shadow_only_coverage", "float");
  const accumulate = extractFunction(shader, "accumulate_layered_sample", "void");
  const pack = extractFunction(shader, "pack_layered_shadow");
  const assembly = compileConstantResult(`
${shadowOnly}
${conditional}
${state}
${accumulate}
${pack}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    LayeredSampleState split = (LayeredSampleState)0;
    accumulate_layered_sample(.4, 0, .3, 1, float2(.2,.2), split);
    accumulate_layered_sample(0, 0, .5, 1, 0, split);
    accumulate_layered_sample(.8, 0, .8, 1, float2(.8,.8), split);
    float4 front = pack_layered_shadow(split, 0);
    float4 rear = pack_layered_shadow(split, 1);
    bool split_ok = abs(front.a-.4)<1e-5 && abs(front.g/front.a-.3)<1e-5
        && abs(rear.a-.8)<1e-5 && abs(rear.g/rear.a-.8)<1e-5
        && abs(max(front.a,rear.a)-.8)<1e-5;
    LayeredSampleState continuous = (LayeredSampleState)0;
    accumulate_layered_sample(.4, 0, .49, 1, 0, continuous);
    accumulate_layered_sample(.8, 0, .51, 1, 0, continuous);
    bool continuous_ok = abs(pack_layered_shadow(continuous,0).a-.8)<1e-5
        && pack_layered_shadow(continuous,1).a==0;
    LayeredSampleState faded = (LayeredSampleState)0;
    accumulate_layered_sample(.55, .25, .2, .5, 0, faded);
    accumulate_layered_sample(0, .25, .5, 1, 0, faded);
    accumulate_layered_sample(.85, .25, .8, .5, 0, faded);
    bool fade_ok = abs(pack_layered_shadow(faded,0).a-.2)<1e-5
        && abs(pack_layered_shadow(faded,1).a-.4)<1e-5;
    LayeredSampleState opaque = (LayeredSampleState)0;
    accumulate_layered_sample(1, 0, .2, 1, 0, opaque);
    accumulate_layered_sample(0, 0, .5, 1, 0, opaque);
    accumulate_layered_sample(.7, 0, .8, 1, 0, opaque);
    bool opaque_ok = pack_layered_shadow(opaque,1).a>.69;
    bool correct = split_ok && continuous_ok && fade_ok && opaque_ok;
    return correct ? float4(0,1,0,1) : float4(1,0,0,1);
}`);
  assert.match(assembly, /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/);
});

test("layer combine applies correlated coverage and global opacity once", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(/--\[\[pixelshader@combine_shadow_layers:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "combine_shadow_layers shader was not found");
  const combine = extractFunction(shader, "combine_layer_colors");
  const assembly = compileConstantResult(`
${combine}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 result = combine_layer_colors(float4(.4,0,0,.4), float4(0,0,.5,.5), .5);
    float4 opaque = combine_layer_colors(float4(.3,.2,.1,1), float4(0,0,.5,.5), .5);
    bool correct = all(abs(result-float4(.2,0,.05,.25))<1e-5)
        && all(abs(opaque-float4(.15,.1,.05,.5))<1e-5);
    return correct ? float4(0,1,0,1) : float4(1,0,0,1);
}`);
  assert.match(assembly, /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/);
});

test("Directional blur alone routes through both shadow layers", () => {
  const source = readFileSync(scriptPath, "utf8");
  const renderBlock = source.slice(source.lastIndexOf("if should_render_shadow then"),
    source.indexOf("local object_red", source.lastIndexOf("if should_render_shadow then")));
  assert.match(renderBlock, /shadow_type == 0 and blur_shadow > 0/);
  assert.match(renderBlock, /for layer = 0, 1 do/);
  assert.match(renderBlock, /combine_shadow_layers/);
  assert.match(renderBlock, /work_scale, -1\)/);
  assert.match(source, /"layer_front"/);
  assert.match(renderBlock, /else[\s\S]*obj\.clearbuffer\("cache:longshadown_final", obj\.w, obj\.h\)/);
});

test("Fade sample switches keep blur distance continuous near the shadow root", () => {
  const source = readFileSync(scriptPath, "utf8");
  for (const shaderName of ["direct_raymarch_shadow", "edge_antialias"]) {
    const shader = source.match(
      new RegExp(`--\\[\\[pixelshader@${shaderName}:([\\s\\S]*?)\\]\\]`),
    )?.[1];
    assert.ok(shader, `${shaderName} shader was not found`);
    const helpers = [
      extractFunction(shader, "union_coverage", "float"),
      extractFunction(shader, "shadow_only_coverage", "float"),
      extractFunction(shader, "conditional_shadow_coverage", "float"),
      extractFunction(shader, "fade_weight_sample", "float"),
      extractFunction(shader, "accumulate_faded_shadow_sample", "bool"),
    ].join("\n");
    const assembly = compileConstantResult(`
static const float fade_in = 1;
static const float fade_out = 0.5;
${helpers}
float2 sample_ray(float near_alpha) {
    float coverage = 0;
    float weighted_distance = 0;
    accumulate_faded_shadow_sample(near_alpha, 0, 0.1,
        coverage, weighted_distance);
    accumulate_faded_shadow_sample(1, 0, 0.75,
        coverage, weighted_distance);
    return float2(coverage, weighted_distance / coverage);
}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float2 below = sample_ray(0.49);
    float2 above = sample_ray(0.51);
    bool correct = abs(below.x - 0.5) < 1e-6
        && abs(above.x - 0.51) < 1e-6
        && abs(below.y - 0.113) < 1e-6
        && abs(above.y - 0.1) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      `${shaderName} made Blur Shadow jump when the winning Fade sample changed`);
  }
});

test("resolved shadow does not apply Fade a second time", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@resolve_shadow:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "resolve_shadow shader was not found");
  const resolveFaded = extractFunction(
    shader, "resolve_faded_shadow_info", "float4");
  const assembly = compileConstantResult(`
${resolveFaded}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 result = resolve_faded_shadow_info(
        float4(0.2, 0.6328125, 0.3, 0.84375));
    bool correct = all(abs(result
        - float4(0.84375, 0.6328125, 1, 0.84375)) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "resolve_shadow attenuated already-faded ray coverage");
  assert.match(shader,
    /return resolve_faded_shadow_info\(shadow_info\);/,
    "resolve_shadow bypassed the single-Fade resolve contract");
});

test("conditional shadow coverage fills the uncovered root fraction", () => {
  const source = readFileSync(scriptPath, "utf8");
  for (const shaderName of ["direct_raymarch_shadow", "edge_antialias"]) {
    const shader = source.match(
      new RegExp(`--\\[\\[pixelshader@${shaderName}:([\\s\\S]*?)\\]\\]`),
    )?.[1];
    assert.ok(shader, `${shaderName} shader was not found`);
    const conditional = extractFunction(
      shader, "conditional_shadow_coverage", "float");
    const difference = extractFunction(
      shader, "shadow_only_coverage", "float");
    const assembly = compileConstantResult(`
${difference}
${conditional}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    bool correct = abs(conditional_shadow_coverage(0.5, 0.5) - 0.0) < 1e-6
        && abs(conditional_shadow_coverage(0.8, 0.5) - 0.6) < 1e-6
        && abs(conditional_shadow_coverage(0.4, 0.0) - 0.4) < 1e-6
        && abs(conditional_shadow_coverage(1.0, 1.0) - 0.0) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      `${shaderName} did not normalize the shadow into uncovered root coverage`);
  }
});

test("ray union does not amplify repeated antialiased coverage", () => {
  const source = readFileSync(scriptPath, "utf8");
  const directShader = source.match(
    /--\[\[pixelshader@direct_raymarch_shadow:([\s\S]*?)\]\]/)?.[1];
  const edgeShader = source.match(
    /--\[\[pixelshader@edge_antialias:([\s\S]*?)\]\]/)?.[1];
  assert.ok(directShader, "direct_raymarch_shadow shader was not found");
  assert.ok(edgeShader, "edge_antialias shader was not found");

  const directUnion = extractFunction(directShader, "union_coverage", "float");
  const edgeUnion = extractFunction(edgeShader, "union_coverage", "float");
  const difference = extractFunction(
    edgeShader, "shadow_only_coverage", "float");
  const assembly = compileConstantResult(`
${directUnion}
${difference}
float direct_case() {
    float total = union_coverage(0, 0.5);
    total = union_coverage(total, 0.5);
    total = union_coverage(total, 0.5);
    float flat = shadow_only_coverage(total, 0.5);
    total = union_coverage(total, 0.8);
    float protruding = shadow_only_coverage(total, 0.5);
    return abs(flat) < 1e-6 && abs(protruding - 0.3) < 1e-6;
}
${edgeUnion.replaceAll("union_coverage", "edge_union_coverage")}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float repeated = edge_union_coverage(0, 0.5);
    repeated = edge_union_coverage(repeated, 0.5);
    repeated = edge_union_coverage(repeated, 0.5);
    bool correct = direct_case() != 0 && abs(repeated - 0.5) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "repeated samples amplified a non-extending antialiased edge");
});

test("2x resolve averages already-faded per-sample coverage", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@resolve_shadow:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "resolve_shadow shader was not found");
  const resolveFaded = extractFunction(
    shader, "resolve_faded_shadow_info", "float4");
  const assembly = compileConstantResult(`
${resolveFaded}
float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 averaged = (float4(0.2, 0.1, 0.3, 0.2)
        + float4(0.4, 0.6, 0.5, 0.8)) * 0.5;
    float4 result = resolve_faded_shadow_info(averaged);
    bool correct = all(abs(result - float4(0.5, 0.35, 1, 0.5)) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/);
  assert.match(shader, /shadow_info \/= 4;[\s\S]*return resolve_faded_shadow_info\(shadow_info\);/,
    "2x resolve did not average completed per-sample Fade results");
});

test("resolve shadow constants preserve HLSL register alignment", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@resolve_shadow:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "resolve_shadow shader was not found");
  assert.match(shader,
    /float work_scale;\s*float2 source_offset;\s*float source_padding;\s*float2 source_size;/,
    "resolve_shadow source_size can straddle the Lua/HLSL register boundary");
  assert.match(source,
    /fade_out \/ 100, work_scale,\s*source_offset_x, source_offset_y, 0, source_w, source_h/,
    "Lua did not supply the HLSL padding slot before source_size");
});

test("edge refinement emits per-sample faded coverage in resolved red", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@edge_antialias:([\s\S]*?)\]\]/)?.[1];
  assert.ok(shader, "edge_antialias shader was not found");
  assert.match(shader,
    /float root_alpha\s*=\s*sample_source_alpha\(pixel\)/,
    "refinement did not sample root coverage at the refined subpixel");
  assert.match(shader,
    /accumulate_faded_shadow_sample\(sample_alpha, root_alpha,\s*distance, coverage, weighted_distance\)/,
    "refinement did not apply Fade to each correlated ray sample");
  assert.match(shader,
    /float4 contribution\s*=\s*float4\(coverage, weighted_distance,/);
});

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

test("coverage difference does not alter quality sample spacing", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /extension_sample_alpha|minimum_travel/);
});

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

test("final compositing no longer guesses extension from first-hit distance", () => {
  const source = readFileSync(scriptPath, "utf8");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  assert.doesNotMatch(prepareShadow, /shadow_info|distance/);
  const composite = extractFunction(source, "composite_shadow");
  assert.doesNotMatch(composite, /shadow_info_texture/);
  assert.match(source,
    /obj\.pixelshader\("composite_shadow",\s*"object",\s*\{\s*"cache:longshadown_final",\s*"cache:longshadown_source"\s*\}/);
});

test("full composition keeps fractional overlap premultiplied", () => {
  const source = readFileSync(scriptPath, "utf8");
  const colorObject = extractFunction(source, "color_object");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  const cases = [
    ["0", "float4(0, 0, 0.25, 0.25)"],
    ["0.5", "float4(0.25, 0.25, 0.5, 0.5)"],
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

test("full composition preserves absolute shadow coverage at source edges", () => {
  const source = readFileSync(scriptPath, "utf8");
  const colorObject = extractFunction(source, "color_object");
  const prepareShadow = extractFunction(source, "prepare_shadow_for_object");
  const cases = [
    ["0", "float4(0, 0, 0.5, 0.5)"],
    ["0.5", "float4(0.25, 0.25, 0.75, 0.75)"],
    ["1", "float4(0.5, 0.5, 1, 1)"],
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
    // T=1 and R=0.5 produce conditional coverage C=(T-R)/(1-R)=1.
    float4 conditional_shadow = float4(0, 0, 1, 1);
    float4 shadow = prepare_shadow_for_object(conditional_shadow, original);
    float4 styled = color_object(original);
    float4 result = styled + shadow * (1 - styled.a);
    bool correct = all(abs(result - ${expected}) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      `source-edge shadow gap at Object Opacity ${opacity}`);
  }
});

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
    float4 shadow = prepare_shadow_for_object(blue_shadow, original);
    float4 styled = color_object(original);
    float4 result = styled + shadow * (1 - styled.a);
    float4 no_shadow = prepare_shadow_for_object(
        float4(0, 0, 0, 0), original);
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
      expected: "float4(0, 0, 1.0 / 3, 1.0 / 3)",
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
    float4 result = prepare_shadow_for_object(shadow, source_sample);
    bool correct = all(abs(result - ${testCase.expected}) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
    assert.match(assembly,
      /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
      testCase.name);
  }
});

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
    float4 prepared = prepare_shadow_for_object(blue_shadow, original);
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
