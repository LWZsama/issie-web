import { Workspace, normal } from "./workspace.mjs";
import { contextMenu } from "./menu.mjs";
import { decodeProjectFragment } from "../static/project-link.mjs";

const errors = [];
let notify;
function report(message) { if (notify) notify(message); else errors.push(message); }
const workspace = new Workspace(report);
const platform = navigator.userAgentData?.platform || navigator.platform || "";
const isMac = /mac|iphone|ipad/i.test(platform);

function selectFiles(directory) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true;
    if (directory) input.webkitdirectory = true; else input.accept = ".dgm";
    input.onchange = () => resolve(Array.from(input.files));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

function pickerOptions(start) {
  return start && normal(start).startsWith("/local/") ? { startIn: workspace.owner(start)?.handle } : {};
}

let savedMounts;
async function mountDatabase() {
  if (!globalThis.indexedDB) return;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("issie-web-directory-handles", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("folders");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function restoreMounts() {
  // Browsers can require fresh permission after a restart. Browse will request it again.
  try {
    savedMounts = await mountDatabase();
    if (!savedMounts) return;
    const entries = await new Promise((resolve, reject) => {
      const req = savedMounts.transaction("folders").objectStore("folders").getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    for (const { root, handle } of entries) {
      try {
        if (await handle.queryPermission({ mode: "readwrite" }) === "granted") await workspace.mount(root, handle);
      } catch (error) { report(`Could not restore ${root}. ${error.message}`); }
    }
  } catch (error) { report("Could not restore a local folder. " + error.message); }
}

async function pickFolder(start) {
  try {
    if (window.showDirectoryPicker) {
      const handle = await window.showDirectoryPicker({ mode: "readwrite", ...pickerOptions(start) });
      const root = await workspace.attach(handle);
      const mount = workspace.owner(root);
      if (savedMounts && mount.root.startsWith("/local/")) {
        savedMounts.transaction("folders", "readwrite").objectStore("folders")
          .put({ root: mount.root, handle: mount.handle }, mount.root);
      }
      return root;
    }
    const files = await selectFiles(true);
    if (!files.length) return;
    const folder = files[0].webkitRelativePath.split("/")[0];
    let root = "/Documents/" + folder;
    for (let n = 2; workspace.entries.has(root); n++) root = "/Documents/" + folder + "_" + n;
    workspace.mkdir(root);
    for (const file of files) {
      const parts = file.webkitRelativePath.split("/").slice(1);
      if (parts.some(part => part.startsWith(".") || part === "node_modules")) continue;
      if (!/\.(dgm|ldgm|dprj|dgmauto|ram|v|sv|vh|txt|json)$/i.test(file.name)) continue;
      let dir = root;
      for (const part of parts.slice(0, -1)) { dir += "/" + part; workspace.mkdir(dir); }
      workspace.write(dir + "/" + file.name, await file.text());
    }
    return root;
  } catch (error) { if (error.name !== "AbortError") throw error; }
}

async function pickSheets(start) {
  try {
    const selected = window.showOpenFilePicker
      ? await window.showOpenFilePicker({ multiple: true, ...pickerOptions(start),
        types: [{ description: "Issie sheets", accept: { "application/json": [".dgm"] } }] })
      : await selectFiles(false);
    const root = "/imports/" + (++workspace.nextId);
    const paths = [];
    for (const entry of selected) {
      if (entry.kind) {
        const known = await workspace.resolve(entry);
        if (known) { paths.push(known); continue; }
      }
      const file = entry.kind ? await entry.getFile() : entry;
      workspace.mkdir(root);
      const path = root + "/" + file.name;
      workspace.write(path, await file.text()); paths.push(path);
    }
    return paths;
  } catch (error) { if (error.name === "AbortError") return []; throw error; }
}

function download(path, text) {
  const a = document.createElement("a");
  a.download = path.split("/").pop(); a.href = URL.createObjectURL(new Blob([text]));
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let current, offeredRoot, dirty = false, exporting;
const host = {
  pickFolder, pickSheets,
  projectChanged(path, changed) {
    path = path ? normal(path) : null;
    if (current !== path) workspace.release(current);
    current = path; dirty = changed;
  },
  saveCopy(root) {
    root = normal(root);
    if (!root.startsWith("/shared/") || workspace.owner(root) || exporting) return;
    exporting = (async () => {
      let directory;
      if (window.showDirectoryPicker) directory = await window.showDirectoryPicker({ mode: "readwrite" });
      else {
        const name = prompt("Save a copy in Issie's browser Documents folder", root.split("/").pop());
        if (!name) return;
        if (/[\\/]/.test(name) || name === "." || name === "..") throw new Error("Invalid project name.");
        const docs = workspace.owner("/Documents");
        if (!docs) throw new Error("Persistent browser storage is unavailable.");
        const dest = "/Documents/" + name;
        if (workspace.entries.has(dest)) throw new Error("A project with that name already exists.");
        workspace.mkdir(dest); await workspace.flush(docs);
        directory = await docs.handle.getDirectoryHandle(name);
      }
      if (current !== root) return;
      await workspace.exportCopy(root, directory);
      if (!window.showDirectoryPicker) await workspace.mount("/Documents", workspace.owner("/Documents").handle);
    })().catch(error => { if (error.name !== "AbortError") report(error.message); }).finally(() => { exporting = null; });
  },
  listen(offer, error) {
    notify = error; errors.splice(0).forEach(error);
    let serial = 0;
    async function read() {
      const request = ++serial;
      try {
        const project = await decodeProjectFragment(location.hash);
        if (project && request === serial) offer(() => {
          if (request !== serial) return null;
          if (offeredRoot !== current) workspace.release(offeredRoot);
          offeredRoot = workspace.workingCopy(project);
          return offeredRoot;
        });
      } catch (e) { if (request === serial) error("Could not open project link. " + e.message); }
    }
    window.addEventListener("hashchange", read); read();
    return () => { serial++; notify = null; window.removeEventListener("hashchange", read); };
  },
};

function bridge() {
  let zoom = 0;
  const hardware = () => Promise.reject(new Error("USB debugging requires a supported hardware host."));
  return {
    bootstrap: { platform: isMac ? "darwin" : /win/i.test(platform) ? "win32" : "linux",
      osRelease: platform, arch: navigator.userAgentData?.architecture || "", electronVersion: "Web",
      chromeVersion: navigator.userAgent, cwd: "/", documents: "/Documents", userData: "/userData", staticDir: "/static",
      isDev: false, hasDebugSwitch: false, hasWSwitch: false, logSwitch: "" },
    fs: {
      readFile: p => workspace.read(p), writeFile: (p, text) => {
        workspace.write(p, text);
        if (normal(p).startsWith("/downloads/")) download(normal(p), text);
      },
      exists: p => workspace.entries.has(normal(p)), isDirectory: p => workspace.isDirectory(p),
      mkdir: p => workspace.mkdir(p), readdir: p => workspace.list(p),
      readdirDirectories: p => workspace.list(p).filter(name => workspace.isDirectory(p + "/" + name)),
      unlink: p => workspace.unlink(p), rename: (p, to) => workspace.rename(p, to),
      modifiedTimeMs: p => workspace.entries.get(normal(p))?.time ?? null,
    },
    browse: { folder: p => workspace.browse(p), admitProject: p => workspace.list(p).some(n => /\.(dprj|dgm|ldgm)$/i.test(n)) },
    dialog: {
      open() { throw new Error("A native file picker needs the browser's asynchronous dialog adapter."); },
      save(options) {
        const name = prompt(options.title || "Save file", "memory.ram");
        if (!name || /[\\/]/.test(name) || name === "." || name === "..") return "";
        return "/downloads/" + name;
      },
    },
    window: {
      getZoomLevel: () => zoom,
      setZoomLevel(level) { zoom = level; document.body.style.zoom = 1.2 ** level; },
      toggleFullScreen: () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(),
      edit: op => document.execCommand(op),
    },
    clipboardWrite: text => navigator.clipboard.writeText(text).catch(e => report(e.message)),
    openExternal: url => { if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer"); },
    revealInFileManager: async () => "The browser cannot open the system file manager.",
    build: { start() { report("The FPGA toolchain requires a local installation."); return ""; },
      status: () => -2, cancel() {}, runDevTool() {} },
    uart: { connectAndRead: hardware, simpleConnect: hardware, disconnect() {}, step() {}, pause() {}, continue() {},
      readAllViewers: hardware, stepAndReadAllViewers: hardware },
    diagnostics: { resourceUsage: () => ({}), clearCache() {}, processMemory: async () => ({}),
      systemMemory: () => ({ total: 0 }), ipcListenerCounts: () => ({}) },
    sidecar: { port: () => ({ port: 0, token: "issie-web" }) },
    ipc: { ...contextMenu(isMac), quit: () => window.close(), toggleDevTools() {}, setApplicationMenu() {},
      onClosingWindow() {}, onWindowLostFocus: callback => window.addEventListener("blur", callback), onApplicationMenuCommand() {} },
  };
}

async function start() {
  const assets = await fetch(new URL("static/workspace.json", document.baseURI));
  if (!assets.ok) throw new Error("Cannot load the bundled desktop demos and libraries.");
  workspace.populate("/static", await assets.json());
  try {
    const disk = await navigator.storage.getDirectory();
    for (const name of ["Documents", "userData"]) {
      await workspace.mount("/" + name, await disk.getDirectoryHandle(name, { create: true }));
    }
  } catch { report("Persistent browser storage is unavailable. Projects in this tab are temporary."); }
  await restoreMounts();
  window.issieWeb = host;
  window.issieBridge = bridge();
  window.addEventListener("beforeunload", event => {
    if (dirty || exporting || workspace.pending || workspace.unexported.has(current)) {
      event.preventDefault(); event.returnValue = "";
    }
  });
  window.addEventListener("pointerdown", event => {
    if (event.target.closest?.("#Canvas")) document.getElementById("Canvas")?.focus({ preventScroll: true });
  }, true);
  await import("issie/renderer");
}
start().catch(error => { document.getElementById("app").textContent = "Could not open Issie. " + error.message; });
