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

test("inverse direct dispatch keeps Ultra Directional and Radial paths unchanged", () => {
  const source = readFileSync(scriptPath, "utf8");
  const dispatch = source.match(
    /if effective_quality == 3 then[\s\S]*?\r?\n    end\r?\n    style_and_filter_shadow\([\s\S]*?inverse_quality_step\)/,
  );
  assert.ok(dispatch, "shadow renderer dispatch was not found");
  assert.match(dispatch[0], /if effective_quality == 3 then[\s\S]*?render_ultra_raymarch\([\s\S]*?elseif shadow_type == 0 then[\s\S]*?render_fast_directional\([\s\S]*?elseif shadow_type == 1 then[\s\S]*?render_radial_scale\([\s\S]*?elseif shadow_type == 2 then[\s\S]*?render_inverse_direct\(/);
  assert.match(dispatch[0], /target_scale, refine_sample_count, inverse_quality_step = render_inverse_direct/);
  assert.match(dispatch[0], /style_and_filter_shadow\([\s\S]*?refine_samples, inverse_quality_step\)/);
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
