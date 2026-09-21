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

function extractFunction(source, name) {
  const signature = `float4 ${name}(`;
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
