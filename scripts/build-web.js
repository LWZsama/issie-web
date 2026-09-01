const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "web");
const buildDir = path.join(webDir, "build");
const generatedDir = path.join(rootDir, ".web-generated", "renderer");
const wasmProject = path.join(webDir, "wasm", "Issie.Sidecar.Wasm.Host.csproj");
const wasmBuildDir = path.join(buildDir, "wasm");
const wasmAppBundleDir = path.join(
  webDir,
  "wasm",
  "bin",
  "Release",
  "net10.0",
  "browser-wasm",
  "AppBundle",
  "_framework",
);
const fsExtra = require(path.join(webDir, "node_modules", "fs-extra"));
const webpack = require(path.join(webDir, "node_modules", "webpack"));
process.env.NODE_ENV = process.env.NODE_ENV || "production";

const rendererConfig = require("../web/webpack.config");

function createDotnetEnv() {
  const userProfile = path.join(rootDir, ".user");

  return {
    ...process.env,
    DOTNET_CLI_HOME: path.join(rootDir, ".dotnet"),
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    NUGET_PACKAGES: path.join(rootDir, ".nuget", "packages"),
    USERPROFILE: userProfile,
    APPDATA: path.join(userProfile, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(userProfile, "AppData", "Local"),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: createDotnetEnv(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function buildWebpack() {
  return new Promise((resolve, reject) => {
    webpack(rendererConfig).run((err, stats) => {
      if (err) {
        reject(err);
        return;
      }

      if (!stats) {
        reject(new Error("Webpack did not return build stats."));
        return;
      }

      process.stdout.write(`${stats.toString({ colors: true })}\n`);

      if (stats.hasErrors()) {
        reject(new Error("Webpack build failed."));
        return;
      }

      resolve();
    });
  });
}

async function writeDirectoryManifest(directoryPath) {
  const entries = await fsExtra.readdir(directoryPath, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));

  await fsExtra.writeJson(path.join(directoryPath, "index.json"), names, { spaces: 2 });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await writeDirectoryManifest(path.join(directoryPath, entry.name));
    }
  }
}

async function writeDemoBundle(demoDirectoryPath) {
  const bundleExtensions = new Set([".dgm", ".ram", ".txt"]);
  const entries = await fsExtra.readdir(demoDirectoryPath, { withFileTypes: true });
  const files = {};

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!bundleExtensions.has(extension)) {
      continue;
    }

    const filePath = path.join(demoDirectoryPath, entry.name);
    files[entry.name] = await fsExtra.readFile(filePath, "utf8");
  }

  await fsExtra.writeJson(
    path.join(demoDirectoryPath, "demo.json"),
    { files },
    { spaces: 2 },
  );
}

async function prepareDemoManifests() {
  const demosDir = path.join(buildDir, "static", "demos");

  if (await fsExtra.pathExists(demosDir)) {
    const entries = await fsExtra.readdir(demosDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await writeDemoBundle(path.join(demosDir, entry.name));
      }
    }

    await writeDirectoryManifest(demosDir);
  }
}

async function prepareGeneratedRenderer() {
  const assets = [
    ["src/Renderer/scss", "scss"],
    ["src/Renderer/VerilogComponent/VerilogGrammar.js", "VerilogComponent/VerilogGrammar.js"],
    ["src/Renderer/VerilogComponent/parser.js", "VerilogComponent/parser.js"],
    ["src/Renderer/VerilogComponent/prism.css", "VerilogComponent/prism.css"],
    ["src/Renderer/VerilogComponent/prism.js", "VerilogComponent/prism.js"],
    ["src/Renderer/UartFiles/IS-uart-browser.js", "UartFiles/IS-uart-browser.js"],
  ];

  for (const [source, destination] of assets) {
    await fsExtra.copy(
      path.join(rootDir, source),
      path.join(generatedDir, destination),
    );
  }

  const generatedMainCss = path.join(generatedDir, "scss", "main.css");
  if (await fsExtra.pathExists(generatedMainCss)) {
    const css = await fsExtra.readFile(generatedMainCss, "utf8");
    await fsExtra.writeFile(
      generatedMainCss,
      css.replaceAll(
        "./../../../node_modules/font-awesome",
        "./../../../web/node_modules/font-awesome",
      ),
    );
  }

  // Fable emits this worker as TestWorker.js, while the upstream source keeps
  // the generated-module suffix in its URL. Keep the source unchanged and
  // provide the expected browser bundle name at build time.
  const generatedWorker = path.join(generatedDir, "TestWorker.js");
  const workerUrlTarget = path.join(generatedDir, "TestWorker.fs.js");
  if (await fsExtra.pathExists(generatedWorker)) {
    await fsExtra.copy(generatedWorker, workerUrlTarget);
  }
}

async function prepareWasmRuntime() {
  await fsExtra.ensureDir(wasmBuildDir);
  run("dotnet", ["restore", wasmProject, "--configfile", "Nuget.Config"]);
  run("dotnet", ["publish", wasmProject, "-c", "Release", "--no-restore", "-o", wasmBuildDir]);
  await fsExtra.copy(wasmAppBundleDir, wasmBuildDir, { overwrite: true });

  for (const fileName of ["main.mjs", "dotnet.boot.js", "dotnet.js"]) {
    if (!(await fsExtra.pathExists(path.join(wasmBuildDir, fileName)))) {
      throw new Error(`WASM publish did not produce ${fileName}.`);
    }
  }
}

async function prepareStaticSite() {
  await fsExtra.ensureDir(buildDir);

  const staticDir = path.join(rootDir, "static");
  if (await fsExtra.pathExists(staticDir)) {
    await fsExtra.copy(staticDir, path.join(buildDir, "static"));
    await prepareDemoManifests();
  }

  const noJekyllSource = path.join(rootDir, ".nojekyll");
  const noJekyllTarget = path.join(buildDir, ".nojekyll");
  if (await fsExtra.pathExists(noJekyllSource)) {
    await fsExtra.copy(noJekyllSource, noJekyllTarget);
  } else {
    await fsExtra.ensureFile(noJekyllTarget);
  }

  const faviconSource = path.join(rootDir, "public", "icon.ico");
  if (await fsExtra.pathExists(faviconSource)) {
    await fsExtra.copy(faviconSource, path.join(buildDir, "favicon.ico"));
  }
}

(async () => {
  await fsExtra.remove(buildDir);
  await fsExtra.remove(generatedDir);
  await fsExtra.remove(path.join(rootDir, ".fable"));

  run("dotnet", ["tool", "restore"]);
  run("dotnet", ["paket", "restore"]);
  run("dotnet", ["restore", "src/Renderer/Renderer.fsproj", "--configfile", "Nuget.Config"]);
  run("dotnet", ["fable", "src/Renderer/Renderer.fsproj", "--outDir", generatedDir, "--noCache"]);

  await prepareGeneratedRenderer();
  await prepareWasmRuntime();
  await buildWebpack();
  await prepareStaticSite();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
