// Run the real Web app and desktop sidecar against the same sheets. Requires a DEBUG Web build.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { brotliCompressSync, constants } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function browserCheck(desktopUrl, expectedDemos, expectedFiles, oversizedLink) {
  function check(value, message) { if (!value) throw new Error(message); }
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const frame = document.querySelector("iframe");
  const app = frame.contentWindow;
  async function until(fn) {
    for (let i = 0; i < 300; i++) {
      const result = await fn(); if (result) return result;
      await delay(100);
    }
    throw new Error("Timed out: " + fn + "\n" + app.document.body.innerText.slice(0, 500));
  }
  const control = label => Array.from(app.document.querySelectorAll("button,a")).find(el => el.innerText.trim() === label);
  // A single visit must prepare even the simulator. Disable the asset server before opening any project.
  frame.src = "./";
  await until(() => app.issieDev?.state().ready &&
    app.navigator.serviceWorker.controller && navigator.serviceWorker.controller);
  check((await app.navigator.serviceWorker.ready).scope === new URL("./", location.href).href, "Wrong app scope");
  check((await fetch("/offline", { method: "POST" })).ok, "Could not take the asset server offline");
  frame.src = "about:blank";
  await until(() => app.location.href === "about:blank");
  await Promise.all(expectedFiles.map(async file => {
    const response = await fetch(file, { cache: "no-store" });
    check(response.ok, "Missing offline asset: " + file);
    await response.arrayBuffer();
  }));
  const { createProjectUrl, decodeProjectFragment } = await import("./static/project-link.mjs");
  let limitError;
  try { await decodeProjectFragment(oversizedLink); } catch (error) { limitError = error.message; }
  check(limitError?.includes("32 MiB"), "Offline Brotli decoder did not enforce the expanded size limit");
  frame.src = "./#demo=3&code=1234";
  await until(() => app.issieDev?.state().ready);
  check(app.document.title === "Issie Web", "Wrong tab title");
  const favicon = new Image();
  favicon.src = app.document.querySelector('link[rel="icon"]').href;
  await favicon.decode();
  const manifest = await (await fetch(app.document.querySelector('link[rel="manifest"]').href)).json();
  check(manifest.name === "Issie Web" && manifest.display === "standalone", "Wrong installed app metadata");
  check(!app.issieDev.state().project, "The legacy URL opened a project");
  control("Open demo project").click();
  await until(() => app.document.body.innerText.includes("Choose Demo Project"));
  const labels = [...app.document.querySelectorAll("a")].map(a => a.innerText.trim().split("\n")[0]);
  check(expectedDemos.every(name => labels.includes(name.slice(1))), "A desktop demo is missing from the menu");
  const old = app.document;
  frame.src = "./?open";
  await until(() => app.document !== old && app.issieDev?.state().ready);
  // Exercise the actual desktop new-project form with a browser directory handle. A native
  // picker cannot be automated by a page, so grant an isolated test directory for that one call.
  const disk = await navigator.storage.getDirectory();
  const chosen = await disk.getDirectoryHandle("smoke-projects", { create: true });
  const existing = await chosen.getDirectoryHandle("Existing", { create: true });
  const sentinel = await existing.getFileHandle("main.dgm", { create: true });
  const writer = await sentinel.createWritable(); await writer.write("existing schematic"); await writer.close();
  app.showDirectoryPicker = async () => chosen;
  control("New project").click(); await until(() => control("Browse..."));
  control("Browse...").click();
  await until(() => app.document.querySelector('input[placeholder="Folder to create the project in"]')?.value.endsWith(chosen.name));
  const name = app.document.querySelector('input[placeholder="Project name"]');
  function type(value) {
    Object.getOwnPropertyDescriptor(app.HTMLInputElement.prototype, "value").set.call(name, value);
    name.dispatchEvent(new app.Event("input", { bubbles: true }));
  }
  type("Existing"); await until(() => control("Create")?.disabled && app.document.body.innerText.includes("already exists"));
  type("Fresh"); await until(() => control("Create") && !control("Create").disabled); control("Create").click();
  await until(() => app.issieDev.state().project.endsWith("Fresh"));
  check(await (await sentinel.getFile()).text() === "existing schematic", "An existing project was overwritten");
  let saved = false;
  for (let i = 0; i < 50 && !saved; i++) {
    try {
      const created = await chosen.getDirectoryHandle("Fresh");
      await created.getFileHandle("Fresh.dprj"); await created.getFileHandle("main.dgm"); saved = true;
    } catch { await delay(100); }
  }
  check(saved, "The project was not written to the selected disk folder");
  const assets = await (await fetch("static/workspace.json")).json();
  const demos = new Set(Object.keys(assets).filter(p => p.startsWith("demos/")).map(p => p.split("/")[1]));
  check([...demos].sort().join("|") === expectedDemos.join("|"), "Different demos from the selected desktop release");
  check(app.issieBridge.browse.folder("/static/libraries").entries.some(e => e.componentCount > 0), "Missing bundled library");

  const lost = await chosen.getDirectoryHandle("Markerless", { create: true });
  const sheet = await lost.getFileHandle("halfadd.dgm", { create: true });
  const contents = await sheet.createWritable();
  await contents.write(assets["demos/1fulladder/halfadd.dgm"]); await contents.close();
  const prior = app.document; frame.src = "./?recover";
  await until(() => app.document !== prior && app.issieDev?.state().ready);
  // Hold the real worker's ready signal until the first simulation connects.
  const NativeWorker = app.Worker;
  const workerSheets = [];
  let releaseReady;
  app.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (options?.name !== "issie-simulation") return;
      workerSheets.push(app.issieDev.state().openSheet);
      this.addEventListener("message", event => {
        if (!event.data.issieWasmReady) return;
        event.stopImmediatePropagation();
        releaseReady = () => this.dispatchEvent(new app.MessageEvent("message", { data: event.data }));
      }, { once: true });
    }
  };
  app.showDirectoryPicker = async () => lost;
  control("Open project").click(); (await until(() => control("Browse..."))).click();
  (await until(() => control("Add it and open"))).click();
  await until(() => app.issieDev.state().openSheet === "halfadd");
  const recentPath = app.issieDev.state().project;
  await until(() => releaseReady);
  await until(() => lost.getFileHandle("Markerless.dprj").catch(e => { if (e.name !== "NotFoundError") throw e; }));

  const prefix = "demos/1fulladder/";
  const files = Object.fromEntries(Object.entries(assets).filter(([p]) => p.startsWith(prefix)).map(([p, v]) => [p.slice(prefix.length), v]));
  files["rtl/code.ram"] = "0x00 0x1101\n0x20 0xc0fb";
  const link = new URL(await createProjectUrl({ name: "Parity", files }, app.location.href));
  check(/^#project=[A-Za-z0-9_-]+$/.test(link.hash), "Expected an untagged Brotli link");
  frame.src = link.href;
  await until(() => app.issieDev?.state().openSheet === "fulladd");
  app.issieBridge.ipc.showContextMenu("ComponentWaveSim");
  check([...app.document.querySelectorAll('[role="menuitem"]')].some(b => b.firstChild.textContent === "Add waveforms to viewer"), "Wave menu drift");
  app.dispatchEvent(new Event("blur"));
  let copied;
  Object.defineProperty(app.navigator, "clipboard", { configurable: true, value: { writeText: async text => { copied = text; } } });
  app.document.getElementById("ProjectPath").dispatchEvent(new app.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
  (await until(() => control("Copy path"))).click();
  await until(() => copied?.endsWith("Parity"));
  const exported = await disk.getDirectoryHandle("saved-link", { create: true });
  app.showDirectoryPicker = async () => exported;
  app.issieDev.send("action", "ScSaveSheet");
  await until(async () => {
    try {
      const rtl = await exported.getDirectoryHandle("rtl"), ram = await rtl.getFileHandle("code.ram");
      return await (await ram.getFile()).text() === files["rtl/code.ram"];
    } catch (e) { if (e.name !== "NotFoundError") throw e; }
  });

  // Capture the real renderer's SendDesign frames, including its canonical component IDs.
  const design = [];
  const post = app.Worker.prototype.postMessage;
  app.Worker.prototype.postMessage = function (message, transfer) {
    if (message.frame && new Uint8Array(message.frame)[0] === 4) design.push(message.frame.slice(0));
    return post.call(this, message, transfer);
  };
  const endpoint = app.issieBridge.sidecar.port;
  app.issieBridge.sidecar.port = () => {
    app.issieBridge.sidecar.port = endpoint;
    setTimeout(releaseReady, 0);
    return endpoint();
  };
  app.issieDev.send("sidecarProbe", "12");
  await until(() => JSON.stringify(app.issieLog.lines()).includes("IDENTICAL step data"));
  app.Worker.prototype.postMessage = post;
  check(workerSheets.length === 1 && workerSheets[0] === "halfadd",
    "Expected one simulation worker after opening halfadd, got " + JSON.stringify(workerSheets));
  app.Worker = NativeWorker;
  const decoder = new TextDecoder();
  const sheets = design.map(f => {
    const view = new DataView(f), offset = 20 + view.getUint32(16, true);
    return JSON.parse(decoder.decode(new Uint8Array(f, offset + 4, view.getUint32(offset, true))));
  });
  const input = sheets.find(s => s.SheetName === "fulladd").Components.find(c => JSON.stringify(c.TypeS).includes("Input1"));
  check(input, "No input in the official full adder");

  const worker = new Worker("wasm/main.mjs", { type: "module" });
  await new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => data.issieWasmReady ? resolve() : reject(Error(data.issieWasmError));
    worker.onerror = reject;
  });
  const native = new WebSocket(desktopUrl); native.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => { native.onopen = resolve; native.onerror = reject; });
  const wasmCall = frame => new Promise(resolve => {
    worker.onmessage = ({ data }) => resolve(data.frame);
    worker.postMessage({ connection: 1, frame });
  });
  const nativeCall = frame => new Promise(resolve => { native.onmessage = event => resolve(event.data); native.send(frame); });
  async function exercise(call) {
    let seq = 0;
    function command(cmd, args) {
      const f = new ArrayBuffer(8 + args.length * 4), view = new DataView(f);
      view.setUint8(0, cmd); view.setUint32(1, ++seq, true);
      args.forEach((v, i) => view.setUint32(8 + i * 4, v, true)); return call(f);
    }
    const json = async reply => JSON.parse(decoder.decode(new Uint8Array(await reply, 8)));
    for (const f of design) check(!(await json(call(f))).error, "Design rejected");
    const { epoch, maxArraySize } = await json(command(5, [16384]));
    check(maxArraySize === 16384, "Requested history was capped at " + maxArraySize);
    const cid = input.CompId;
    check(!(await json(command(10, [epoch, 0, 1, cid, 1, 0]))).error, "First input refused");
    check((await json(command(6, [epoch, 9000, 0]))).clockTick === 9000, "First run failed");
    check(!(await json(command(10, [epoch, 9000, 1, cid, 0, 0]))).error, "Second input refused");
    const run = await json(command(6, [epoch, 12000, 0]));
    check(run.done && run.firstValidCycle === 0, "Earlier history was dropped");
    const result = await command(11, [epoch, 0, 1, 12001, 1, cid, 0, 0]);
    const samples = new Uint32Array(result, 24);
    check(samples.length === 12001 && samples[0] === 1 && samples[8192] === 1 && samples[12000] === 0, "Incorrect input waveform");
    const small = await json(command(5, [64]));
    await json(command(6, [small.epoch, 100, 0]));
    const expired = await json(command(11, [small.epoch, 0, 1, 1, 1, cid, 0, 0]));
    check(expired.kind === "refusal", "Expected the desktop expired-history refusal");
    return new Uint8Array(result);
  }
  try {
    const a = await exercise(nativeCall), b = await exercise(wasmCall);
    check(a.length === b.length && a.every((value, i) => value === b[i]), "Desktop and WASM waveform bytes differ");
  } finally { worker.terminate(); native.close(); }

  // Install the permission probe before the entry script, including on a cold #project= navigation.
  const requests = [];
  const held = Promise.withResolvers();
  let permission = held.promise;
  let opening;
  window.observeDirectoryAccess = tab => {
    function access({ mode }) { requests.push([this.name, mode]); return permission; }
    tab.FileSystemHandle.prototype.queryPermission = access;
    tab.FileSystemHandle.prototype.requestPermission = access;
  };
  async function restart(suffix) {
    const previous = app.document;
    frame.src = "./check-folders" + suffix;
    await until(() => app.document !== previous && app.issieDev?.state().ready);
    const openRecent = app.issieWeb.openRecent;
    app.issieWeb.openRecent = (...args) => {
      opening = openRecent(...args);
      return opening;
    };
  }
  const recentRow = (root = app.document) => Array.from(root.querySelectorAll(".recentItem div[title]"))
    .find(row => row.title.replaceAll("\\", "/") === recentPath.replaceAll("\\", "/"));
  const rowStatus = row => row.closest("li").querySelector('[role="status"]');
  function checkHelp(status, message) {
    check(status?.innerText === message + "\nClick × to remove this entry from the list." &&
      status.querySelector("strong")?.textContent === "Open project → Browse...",
      "Unexpected recent project guidance: " + status?.innerText);
  }
  await restart(link.hash);
  await until(() => app.issieDev.state().openSheet === "fulladd");
  await restart("?menu");
  const row = await until(recentRow);
  check(control("Open demo project").compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
    "The saved project was missing below Open demo project");
  check(!requests.length && !app.issieBridge.fs.exists(recentPath), "Startup accessed a saved local folder");
  const clickedAt = performance.now();
  row.click();
  const status = rowStatus(row);
  check(status?.innerText === "Opening…", "Unexpected feedback on click: " + status?.innerText);
  await until(() => requests.length === 1);
  await until(() => status.querySelector("small"));
  check(performance.now() - clickedAt >= 3000, "The folder access hint appeared before three seconds");
  checkHelp(status, "Still waiting for folder access. If you don’t see a permission prompt, choose Open project → Browse... and select this folder again.");
  app.location.hash = link.hash;
  await until(() => app.issieDev.state().openSheet === "fulladd");
  held.resolve("granted");
  await opening;
  check(!status.isConnected && !app.issieBridge.fs.exists(recentPath), "A superseded recent selection was still active");

  await restart("?reopen");
  const covered = Promise.withResolvers();
  permission = covered.promise;
  (await until(recentRow)).click();
  await until(() => requests.length === 2);
  control("Open project").click(); await until(() => control("Browse..."));
  covered.resolve("granted");
  await opening;
  check(!app.issieBridge.fs.exists(recentPath), "A late grant interrupted the project chooser");
  control("Cancel").click();
  permission = Promise.resolve("denied");
  const retryRow = await until(recentRow);
  retryRow.click(); await opening;
  const failed = rowStatus(retryRow);
  const failureText = "Couldn’t reopen this project. Choose Open project → Browse... and select the project folder again.";
  checkHelp(failed, failureText);
  permission = Promise.resolve("granted");
  retryRow.click();
  check(!failed.isConnected && rowStatus(retryRow)?.innerText === "Opening…", "Retry kept the previous failure");
  await until(() => app.issieDev.state().openSheet === "halfadd");
  check(app.issieDev.state().project === recentPath && requests.length === 4 &&
    requests.every(([name, mode]) => name === lost.name && mode === "readwrite"),
    "Reopening a recent project used the wrong folder or permission");

  await restart("?forget");
  control("Open project").click();
  const chooser = (await until(() => control("Browse..."))).closest(".modal");
  const chooserRow = await until(() => recentRow(chooser));
  permission = Promise.resolve("denied");
  chooserRow.click(); await opening;
  const chooserStatus = rowStatus(chooserRow);
  checkHelp(chooserStatus, failureText);
  chooserRow.closest("a").querySelector(".recentForget").click();
  await until(() => !recentRow(chooser));
  check(!chooserStatus.isConnected && requests.length === 5, "Forgetting the project left its hint or retried access");
  return `Full offline build (${expectedFiles.length} files), lazy recent projects, tab identity, project operations, official assets, shared project, upstream menu, worker prewarm and reuse, 12,001 desktop/WASM samples and expired history passed.`;
}

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "build");
const assembly = process.argv[2];
if (!assembly) throw new Error("Pass the path to the upstream desktop issie-sidecar.dll.");
const sitePath = "/issie-web/";
const oversizedLink = "#project=" + brotliCompressSync(Buffer.alloc(32 * 1024 * 1024 + 1), {
  params: { [constants.BROTLI_PARAM_QUALITY]: 1 },
}).toString("base64url");
const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile())
  .map(entry => {
    const relative = path.relative(directory, path.join(entry.parentPath, entry.name));
    return relative.split(path.sep).map(encodeURIComponent).join("/");
  })
  .filter(file => file !== "sw.js");
const desktopRoot = process.env.ISSIE_UPSTREAM_DIR || path.resolve(directory, "../..");
const demos = (await readdir(path.join(desktopRoot, "static/demos"), { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const token = randomUUID();
const sidecar = spawn("dotnet", [path.resolve(assembly)], { windowsHide: true, env: { ...process.env, ISSIE_SIDECAR_TOKEN: token } });
const temporary = await realpath(tmpdir());
const profile = await mkdtemp(path.join(temporary, "issie-web-smoke-"));
let server, chrome, timeout;
try {
  const port = await new Promise((resolve, reject) => {
    let text = "";
    sidecar.stdout.on("data", chunk => {
      text += chunk;
      const match = /SIDECAR_LISTENING (\d+)/.exec(text);
      if (match) resolve(Number(match[1]));
    });
    sidecar.once("error", reject); sidecar.once("exit", code => reject(Error("Sidecar exited: " + code)));
  });
  const outcome = Promise.withResolvers();
  let offline = false;
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === sitePath + "check") {
        const endpoint = `ws://127.0.0.1:${port}/?token=${token}`;
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(`<iframe style="width:1600px;height:950px"></iframe><script type="module">
          const send = value => fetch('/result', {method:'POST',body:JSON.stringify(value)});
          (${browserCheck.toString()})(${[endpoint, demos, files, oversizedLink].map(value => JSON.stringify(value)).join(",")}).then(ok => send({ok}), e => send({error:String(e.stack||e)}))</script>`);
      } else if (url.pathname === sitePath + "check-folders") {
        const html = await readFile(path.join(directory, "index.html"), "utf8");
        res.setHeader("Content-Type", "text/html");
        res.end(html.replace("</head>", "<script>parent.observeDirectoryAccess(window)</script></head>"));
      } else if (url.pathname === "/offline" && req.method === "POST") {
        offline = true; res.writeHead(204); res.end();
      } else if (url.pathname === "/result" && req.method === "POST") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const answer = JSON.parse(Buffer.concat(chunks)); res.end();
        if (answer.error) outcome.reject(Error(answer.error)); else outcome.resolve(answer.ok);
      } else {
        if (!url.pathname.startsWith(sitePath)) throw Error("Outside the app scope");
        if (offline) { res.writeHead(503); res.end(); return; }
        const file = path.resolve(directory, decodeURIComponent(url.pathname.slice(sitePath.length)) || "index.html");
        if (!file.startsWith(directory + path.sep)) throw Error("Invalid path");
        const type = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
          ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".png": "image/png",
          ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
        res.setHeader("Cache-Control", "no-store");
        const data = await readFile(file); res.setHeader("Content-Type", type[path.extname(file)] || "application/octet-stream"); res.end(data);
      }
    } catch { res.writeHead(404); res.end(); }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = process.env.CHROME_PATH || ({
    win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  })[process.platform] || "google-chrome";
  chrome = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-dev-shm-usage",
    "--user-data-dir=" + profile, "--window-size=1660,1060", `http://127.0.0.1:${server.address().port}${sitePath}check`],
    { windowsHide: true, stdio: "ignore" });
  chrome.once("error", outcome.reject);
  timeout = setTimeout(() => outcome.reject(Error("Browser check timed out")), 90000);
  console.log(await outcome.promise);
} finally {
  clearTimeout(timeout); server?.close(); sidecar.stdin.end();
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const stopped = once(chrome, "exit"); chrome.kill(); await stopped;
  }
  // profile is the unique directory returned by mkdtemp above.
  if (path.dirname(await realpath(profile)) === temporary) {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
