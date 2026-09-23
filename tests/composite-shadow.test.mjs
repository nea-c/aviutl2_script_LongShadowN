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

test("direct interval helpers clip directional radial and inverse rays", () => {
  const source = readFileSync(scriptPath, "utf8");
  const clipAxis = extractFunction(source, "clip_parameter_axis", "bool");
  const finishInterval = extractFunction(source, "finish_clipped_interval", "bool");
  const directional = extractFunction(source, "directional_ray_interval", "bool");
  const projection = extractFunction(source, "projection_ray_interval", "bool");
  const distanceFromU = extractFunction(source, "projection_distance_from_u", "float");
  const assembly = compileConstantResult(`
${clipAxis}
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

test("inverse ray interval keeps both samples inside a half-open crossing", () => {
  const source = readFileSync(scriptPath, "utf8");
  const intervalFunction = extractFunction(source, "inverse_ray_interval", "bool");
  const assembly = compileConstantResult(`
${intervalFunction}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_distance, end_distance, source_span;
    float2 origin = float2(2.5, -1.5);
    float2 pixel = float2(1.5, -0.5);
    bool hit = inverse_ray_interval(pixel, origin, float2(0, 0),
        float2(1, 1), 0.25, start_distance, end_distance, source_span);
    float2 first = origin + (pixel - origin) / pow(0.25, start_distance);
    float2 last = origin + (pixel - origin) / pow(0.25, end_distance);
    bool correct = hit && all(first >= 0) && all(first < 1)
        && all(last >= 0) && all(last < 1);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("inverse ray interval preserves a narrow float32 crossing", () => {
  const source = readFileSync(scriptPath, "utf8");
  const intervalFunction = extractFunction(source, "inverse_ray_interval", "bool");
  const assembly = compileConstantResult(`
${intervalFunction}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_distance, end_distance, source_span;
    float2 origin = float2(2.5, -0.5001);
    float2 pixel = float2(1.5, 0.4999);
    bool hit = inverse_ray_interval(pixel, origin, float2(0, 0),
        float2(1, 1), 0.25, start_distance, end_distance, source_span);
    float2 first = origin + (pixel - origin) / pow(0.25, start_distance);
    float2 last = origin + (pixel - origin) / pow(0.25, end_distance);
    bool correct = hit && all(first >= 0) && all(first < 1)
        && all(last >= 0) && all(last < 1);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("inverse ray interval rejects a zero-width excluded tangent", () => {
  const source = readFileSync(scriptPath, "utf8");
  const intervalFunction = extractFunction(source, "inverse_ray_interval", "bool");
  const assembly = compileConstantResult(`
${intervalFunction}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_distance, end_distance, source_span;
    bool hit = inverse_ray_interval(float2(1, 1), float2(2, 0),
        float2(0, 0), float2(1, 1), 0.25,
        start_distance, end_distance, source_span);
    return !hit ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("inverse ray interval rejects a zero-width lower-corner tangent", () => {
  const source = readFileSync(scriptPath, "utf8");
  const intervalFunction = extractFunction(source, "inverse_ray_interval", "bool");
  const assembly = compileConstantResult(`
${intervalFunction}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_distance, end_distance, source_span;
    bool hit = inverse_ray_interval(float2(-1, 1), float2(-2, 2),
        float2(0, 0), float2(1, 1), 0.25,
        start_distance, end_distance, source_span);
    return !hit ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("inverse ray interval preserves a wide span after float32 correction", () => {
  const source = readFileSync(scriptPath, "utf8");
  const intervalFunction = extractFunction(source, "inverse_ray_interval", "bool");
  const assembly = compileConstantResult(`
${intervalFunction}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_distance, end_distance, source_span;
    float2 origin = float2(-3.7, -4);
    float2 pixel = float2(-2.1, -2.3);
    bool hit = inverse_ray_interval(pixel, origin, float2(0, 0),
        float2(1, 1), 0.25, start_distance, end_distance, source_span);
    float2 first = origin + (pixel - origin) / pow(0.25, start_distance);
    float2 last = origin + (pixel - origin) / pow(0.25, end_distance);
    bool correct = hit && source_span > 1.3 && source_span < 1.4
        && all(first >= 0) && all(first < 1)
        && all(last >= 0) && all(last < 1);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("inverse ray interval endpoints survive distance reconstruction", () => {
  const source = readFileSync(scriptPath, "utf8");
  const intervalFunction = extractFunction(source, "inverse_ray_interval", "bool");
  const assembly = compileConstantResult(`
${intervalFunction}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_distance, end_distance, source_span;
    float2 origin = float2(-2.645735740661621, -3.4199843406677246);
    float2 pixel = float2(0.4259900748729706, 0.9993191957473755);
    bool hit = inverse_ray_interval(pixel, origin, float2(0, 0),
        float2(1, 1), 0.25, start_distance, end_distance, source_span);
    float2 first = origin + (pixel - origin) / pow(0.25, start_distance);
    float2 last = origin + (pixel - origin) / pow(0.25, end_distance);
    bool correct = hit && all(first >= 0) && all(first < 1)
        && all(last >= 0) && all(last < 1);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("inverse ray interval reaches the convergence endpoint", () => {
  const source = readFileSync(scriptPath, "utf8");
  const intervalFunction = extractFunction(source, "inverse_ray_interval", "bool");
  const assembly = compileConstantResult(`
${intervalFunction}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float start_distance, end_distance, source_span;
    bool hit = inverse_ray_interval(float2(0.5, 0), float2(0, 0),
        float2(-1, -1), float2(3, 1), 0.25,
        start_distance, end_distance, source_span);
    bool correct = hit && end_distance == 1;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("packed inverse shadow keeps source coordinates distance and coverage channels", () => {
  const source = readFileSync(scriptPath, "utf8");
  const packInverseShadow = extractFunction(source, "pack_inverse_shadow");
  const assembly = compileConstantResult(`
${packInverseShadow}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 result = pack_inverse_shadow(float2(0.25, 0.75), 0.4, 0.5);
    bool correct = all(abs(result - float4(0.25, 0.2, 0.75, 0.5)) < 1e-6);
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );
});

test("inverse direct shader and Lua call share the constant and packed texture contract", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@inverse_raymarch_shadow:\s*([\s\S]*?)\]\]/,
  );
  assert.ok(shader, "inverse_raymarch_shadow shader was not found");
  assert.match(shader[1], /Texture2D source_texture : register\(t0\)/);
  assert.match(shader[1], /cbuffer constant0 : register\(b0\) \{\s*float2 buffer_size;\s*float2 source_offset;\s*float2 source_size;\s*float2 projection_origin;\s*float target_scale;\s*float quality_step;\s*float work_scale;\s*\};/);

  const renderer = source.match(
    /local function render_inverse_direct\([\s\S]*?\r?\nend/,
  );
  assert.ok(renderer, "render_inverse_direct was not found");
  assert.match(renderer[0], /obj\.pixelshader\("inverse_raymarch_shadow", "cache:longshadown_shadow_a",\s*"cache:longshadown_source",\s*\{ buffer_w, buffer_h, source_offset_x, source_offset_y,\s*source_w, source_h, source_pos_x, source_pos_y,\s*target_scale, quality_step, work_scale \}, "copy", "clamp"\)/);
  assert.match(renderer[0], /return target_scale, refine_sample_count, quality_step/);
});

test("inverse direct samples source-linear intervals within quality spacing", () => {
  const source = readFileSync(scriptPath, "utf8");
  const distanceToU = extractFunction(source, "inverse_u_from_distance", "float");
  const uToDistance = extractFunction(source, "inverse_distance_from_u", "float");
  const sampleU = extractFunction(source, "inverse_sample_u", "float");
  const assembly = compileConstantResult(`
${distanceToU}
${uToDistance}
${sampleU}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float target_scale = 0.5 / length(float2(512, 512));
    float delta_length = target_scale * 1024;
    float start_u = inverse_sample_u(0, 1, target_scale, 0, 257);
    float draft_previous_u = inverse_sample_u(0, 1, target_scale, 255, 257);
    float draft_end_u = inverse_sample_u(0, 1, target_scale, 256, 257);
    float standard_previous_u = inverse_sample_u(0, 1, target_scale, 511, 513);
    float standard_end_u = inverse_sample_u(0, 1, target_scale, 512, 513);
    float high_previous_u = inverse_sample_u(0, 1, target_scale, 1023, 1025);
    float high_end_u = inverse_sample_u(0, 1, target_scale, 1024, 1025);
    float metadata_u = 17;
    float metadata_distance = inverse_distance_from_u(target_scale, metadata_u);
    bool correct = abs(start_u - 1) < 1e-6
        && abs(draft_end_u - 1 / target_scale) < 1e-3
        && abs(standard_end_u - 1 / target_scale) < 1e-3
        && abs(high_end_u - 1 / target_scale) < 1e-3
        && delta_length * (draft_end_u - draft_previous_u) <= 4.0001
        && delta_length * (standard_end_u - standard_previous_u) <= 2.0001
        && delta_length * (high_end_u - high_previous_u) <= 1.0001
        && abs(inverse_u_from_distance(target_scale, metadata_distance)
            - metadata_u) < 1e-4;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);
  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
  );

  const shader = source.match(
    /--\[\[pixelshader@inverse_raymarch_shadow:\s*([\s\S]*?)\]\]/,
  );
  assert.ok(shader, "inverse_raymarch_shadow shader was not found");
  assert.match(shader[1], /float sample_u = inverse_sample_u\(start_distance, end_distance,\s*target_scale, sample, active_samples\)/);
  assert.match(shader[1], /source_pixel = projection_origin\s*\+ \(pixel - projection_origin\) \* sample_u/);
  assert.match(shader[1], /distance = inverse_distance_from_u\(target_scale, sample_u\)/);
});

test("inverse direct Lua quality spacing remains 4 2 and 1 source pixels", () => {
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
    /local function render_inverse_direct\([\s\S]*?\r?\nend/,
  );
  assert.ok(renderer, "render_inverse_direct was not found");
  assert.match(renderer[0], /math\.ceil\(effective_length \* work_scale \/ quality_step\) \+ 1/);
  assert.match(renderer[0], /math\.min\(MAX_DIRECT_SAMPLES,/);

  const convergedSourceSpan = 1024 - Math.SQRT1_2;
  const activeCounts = [4, 2, 1].map(
    (qualityStep) => Math.ceil(convergedSourceSpan / qualityStep) + 1,
  );
  assert.deepEqual(activeCounts, [257, 513, 1025]);
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
  assert.match(
    dispatch[0],
    /if shadow_type == 0 and effective_quality < 2 then[\s\S]*?render_fast_directional/,
  );
  assert.match(dispatch[0], /else[\s\S]*?render_direct_shadow/);
  assert.doesNotMatch(
    dispatch[0],
    /render_ultra_raymarch|render_radial_scale|render_inverse_direct/,
  );
});

test("edge Direct helpers keep projection order endpoints and misses", () => {
  const source = readFileSync(scriptPath, "utf8");
  const shader = source.match(
    /--\[\[pixelshader@edge_antialias:\s*([\s\S]*?)\]\]/,
  );
  assert.ok(shader, "edge_antialias shader was not found");
  const clipAxis = extractFunction(shader[1], "clip_parameter_axis", "bool");
  const finishInterval = extractFunction(shader[1], "finish_clipped_interval", "bool");
  const projectionInterval = extractFunction(shader[1], "projection_ray_interval", "bool");
  const distanceFromU = extractFunction(shader[1], "projection_distance_from_u", "float");
  const sampleParameter = extractFunction(shader[1], "direct_sample_parameter", "float");
  const assembly = compileConstantResult(`
${clipAxis}
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
    /target_scale, refine_sample_count, refine_samples, direct_quality_step\)/,
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

  const resolveCall = source.match(
    /obj\.pixelshader\("resolve_shadow"[\s\S]*?\{ buffer_w, buffer_h, ([^,]+), ([^,]+), work_scale \}/,
  );
  assert.ok(resolveCall, "resolve_shadow call was not found");
  const antialiasCall = source.match(
    /obj\.pixelshader\("edge_antialias"[\s\S]*?refine_samples,\s*([^,]+), ([^,]+), effective_quality/,
  );
  assert.ok(antialiasCall, "edge_antialias call was not found");
  const evaluate = (expression, fadeIn, fadeOut) => Function(
    "fade_in", "fade_out", `return ${expression};`,
  )(fadeIn, fadeOut);
  assert.equal(evaluate(resolveCall[1], 100, 50), 1);
  assert.equal(evaluate(resolveCall[2], 100, 50), 0.5);
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

test("object-colored edge backing is independent of shadow opacity", () => {
  const source = readFileSync(scriptPath, "utf8");
  const neutralizeShadow = extractFunction(source, "neutralize_shadow");
  const assembly = compileConstantResult(`
static const float3 object_rgb = float3(1, 0, 0);
static const float object_mix = 1;
static const float object_opacity = 1;
${neutralizeShadow}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float edge_alpha = 1.0 / 255;
    float4 original = float4(edge_alpha, edge_alpha, edge_alpha, edge_alpha);
    float4 dark_shadow = neutralize_shadow(float4(0, 0, 0, 1), original);
    float4 transparent_shadow = neutralize_shadow(float4(0, 0, 0, 0), original);
    float4 dark_result = original + dark_shadow * (1 - original.a);
    float4 transparent_result = original + transparent_shadow * (1 - original.a);
    bool correct = abs(dark_result.a - 1) < 1e-6
        && all(abs(dark_result - transparent_result) < 1e-6);
    return correct
        ? float4(0, 1, 0, 1)
        : float4(1, 0, 0, 1);
}
`);

  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "the antialiased edge was not reinforced independently of the shadow material",
  );
});

test("object opacity can fully hide the source over its shadow", () => {
  const source = readFileSync(scriptPath, "utf8");
  const colorObject = extractFunction(source, "color_object");
  const neutralizeShadow = extractFunction(source, "neutralize_shadow");
  const assembly = compileConstantResult(`
static const float3 object_rgb = float3(1, 0, 0);
static const float object_mix = 1;
static const float object_opacity = 0;
${colorObject}
${neutralizeShadow}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 original = float4(0.25, 0.25, 0.25, 0.5);
    float4 shadow = neutralize_shadow(float4(0, 0, 0, 1), original);
    float4 styled = color_object(original);
    float4 result = styled + shadow * (1 - styled.a);
    return result.a < 1e-6 ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);

  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "shadow coverage substituted for the source after Object::Opacity reached zero",
  );
});

test("object mix is not diluted by the original-colored shadow", () => {
  const source = readFileSync(scriptPath, "utf8");
  const colorObject = extractFunction(source, "color_object");
  const neutralizeShadow = extractFunction(source, "neutralize_shadow");
  const assembly = compileConstantResult(`
static const float3 object_rgb = float3(1, 0, 0);
static const float object_mix = 1;
static const float object_opacity = 1;
${colorObject}
${neutralizeShadow}

float4 testmain(float4 pos : SV_Position) : SV_Target {
    float4 original = float4(0.25, 0.25, 0.25, 0.5);
    float4 shadow = neutralize_shadow(float4(0, 0, 0, 1), original);
    float4 styled = color_object(original);
    float4 result = styled + shadow * (1 - styled.a);
    bool correct = abs(result.r - 1) < 1e-6
        && result.g < 1e-6 && result.b < 1e-6
        && abs(result.a - 1) < 1e-6;
    return correct ? float4(0, 1, 0, 1) : float4(1, 0, 0, 1);
}
`);

  assert.match(
    assembly,
    /mov o0\.xyzw, l\(0(?:\.0+)?,\s*1(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?\)/,
    "the original-colored shadow changed the mixed object's color or alpha",
  );
});
