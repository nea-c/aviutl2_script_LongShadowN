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

test("blur shadow exposes a practical 200 px range in 0.1 px steps", () => {
  const source = readFileSync(scriptPath, "utf8");
  const match = source.match(
    /^--track@blur_shadow:[^,]+,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/m,
  );
  assert.ok(match, "Blur Shadow track was not found");

  assert.deepEqual(match.slice(1).map(Number), [0, 200, 0, 0.1]);
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
  const blurPipeline = source.match(/if blur_shadow > 0 then([\s\S]*?)\n    end\nend/);
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
