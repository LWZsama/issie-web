const path = require("path");
const { spawnSync } = require("child_process");
const fsExtra = require("fs-extra");
const webpack = require("webpack");

const rootDir = path.resolve(__dirname, "..");
const buildDir = path.join(rootDir, "build");
process.env.NODE_ENV = process.env.NODE_ENV || "production";

const rendererConfig = require("../webpack.config.renderer");

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
  await fsExtra.remove(path.join(rootDir, ".fable"));

  run("dotnet", ["tool", "restore"]);
  run("dotnet", ["restore", "src/Renderer/Renderer.fsproj", "--configfile", "Nuget.Config"]);
  run("dotnet", ["fable", "src/Renderer/Renderer.fsproj", "--outDir", "src/Renderer", "--noCache"]);

  await buildWebpack();
  await prepareStaticSite();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
