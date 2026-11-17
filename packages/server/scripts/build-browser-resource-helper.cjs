const { execFileSync } = require("node:child_process");
const { mkdirSync, rmSync, copyFileSync } = require("node:fs");
const path = require("node:path");
function buildBrowserResourceHelper(outputDirectory, arch = process.arch) {
  mkdirSync(outputDirectory, { recursive: true });
  copyFileSync(
    path.join(__dirname, "../src/server/browser-resource-entry.cjs"),
    path.join(outputDirectory, "browser-resource-entry.cjs"),
  );
  const output = path.join(outputDirectory, "paseo-browser-resource");
  const architectures = arch === "universal" ? ["arm64", "x64"] : [arch];
  const outputs = architectures.map((architecture) => {
    if (!["arm64", "x64"].includes(architecture))
      throw new Error("Unsupported browser helper architecture");
    const binary = architectures.length === 1 ? output : `${output}-${architecture}`;
    execFileSync(
      "xcrun",
      [
        "clang",
        "-O2",
        "-Wall",
        "-Werror",
        "-arch",
        architecture === "x64" ? "x86_64" : "arm64",
        "-mmacosx-version-min=13.0",
        path.join(__dirname, "../native/browser-resource/main.c"),
        "-lproc",
        "-o",
        binary,
      ],
      { stdio: "inherit" },
    );
    return binary;
  });
  if (outputs.length > 1) {
    execFileSync("xcrun", ["lipo", "-create", ...outputs, "-output", output]);
    for (const binary of outputs) rmSync(binary);
  }
  return output;
}
module.exports = { buildBrowserResourceHelper };
if (require.main === module && process.platform === "darwin")
  buildBrowserResourceHelper(
    path.join(__dirname, "../dist/server/server"),
    process.argv[2] ?? "universal",
  );
