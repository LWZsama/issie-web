const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");

const root = path.dirname(__dirname);
const output = path.join(__dirname, "build");
const fromRoot = createRequire(path.join(root, "package.json"));

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
}

function staticFiles() {
  const assets = path.join(root, "static");
  const files = Object.create(null);
  function collect(directory) {
    for (const entry of fs.readdirSync(path.join(assets, directory), { withFileTypes: true })) {
      const relative = directory + "/" + entry.name;
      if (entry.isDirectory()) collect(relative);
      else files[relative] = fs.readFileSync(path.join(assets, relative), "utf8");
    }
  }
  collect("demos");
  collect("libraries");
  fs.cpSync(assets, path.join(output, "static"), { recursive: true });
  fs.writeFileSync(path.join(output, "static", "workspace.json"), JSON.stringify(files));
  fs.copyFileSync(path.join(root, "public/icon.ico"), path.join(output, "favicon.ico"));
  for (const name of ["manifest.webmanifest", "icon-192.png"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
  }
  const index = path.join(output, "index.html");
  const head = '<title>Issie Web</title><link rel="icon" href="./favicon.ico">' +
    '<link rel="apple-touch-icon" href="./static/icon.png"><link rel="manifest" href="./manifest.webmanifest">';
  fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("</head>", head + "</head>"));
}

function writeServiceWorker() {
  const paths = fs.readdirSync(output, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(output, path.join(entry.parentPath, entry.name)))
    .filter(file => file !== "sw.js").sort();
  const assets = paths.map(file => {
    const url = file.split(path.sep).map(encodeURIComponent).join("/");
    const hash = createHash("sha256").update(fs.readFileSync(path.join(output, file))).digest("base64");
    return [url, "sha256-" + hash];
  });
  const list = JSON.stringify(assets);
  const script = fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8");
  const revision = createHash("sha256").update(list).update(script).digest("hex");
  fs.writeFileSync(path.join(output, "sw.js"), `const revision = "${revision}";\nconst assets = ${list};\n${script}`);
}

async function build() {
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    if (!process.env.npm_execpath) throw new Error("Run npm ci in the repository root before building.");
    run(process.execPath, [process.env.npm_execpath, "ci"]);
  }
  run("dotnet", ["tool", "restore"]);
  run("dotnet", ["paket", "restore"]);
  run("dotnet", ["restore", "src/Renderer/Renderer.fsproj", "--configfile", "Nuget.Config"]);
  // Keep browser defines out of the JavaScript loaded by Electron.
  const compiled = "build-fable/web";
  const defines = process.env.ISSIE_WEB_FABLE_DEFINES?.split(/[\s,]+/).filter(Boolean) || [];
  run("dotnet", ["fable", "src/Renderer/Renderer.fsproj", "--noCache", "-o", compiled, "-e", ".fs.js",
    "--configuration", "Release", "--define", "PRODUCTION", "--define", "ISSIE_WEB",
    ...defines.flatMap(name => ["--define", name])]);

  process.env.NODE_ENV = "production";
  const webpack = fromRoot("webpack");
  const desktop = fromRoot("./webpack.config.renderer.js");
  const config = {
    ...desktop, context: root, entry: path.join(__dirname, "start.mjs"),
    output: { ...desktop.output, path: output, publicPath: "./", clean: true },
    resolve: { ...desktop.resolve, alias: {
      "issie/renderer$": path.join(root, compiled, path.basename(desktop.entry)),
      "issie/menus$": path.join(root, compiled, "Shared/ContextMenus.fs.js"),
    } },
    plugins: [...desktop.plugins, new webpack.ProvidePlugin({ WebSocket: [path.join(__dirname, "socket.mjs"), "HostSocket"] })],
  };
  await new Promise((resolve, reject) => webpack(config).run((err, stats) => {
    if (err || stats.hasErrors()) reject(err || new Error(stats.toString({ all: false, errors: true })));
    else resolve();
  }));
  const host = "web/wasm/Issie.Sidecar.Wasm.Host.csproj";
  run("dotnet", ["restore", host, "--configfile", "Nuget.Config"]);
  run("dotnet", ["publish", host, "-c", "Release", "--no-restore"]);
  const bundle = path.join(__dirname, "wasm/bin/Release/net10.0/browser-wasm/AppBundle");
  const framework = path.join(output, "wasm");
  fs.cpSync(path.join(bundle, "_framework"), framework, { recursive: true });
  fs.copyFileSync(path.join(bundle, "main.mjs"), path.join(framework, "main.mjs"));
  staticFiles();
  writeServiceWorker();
  console.log(`Built Issie Web ${fromRoot("./package.json").version} in ${output}`);
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
