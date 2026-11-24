import { Workspace, normal } from "./workspace.mjs";
import { contextMenu } from "./menu.mjs";
import { prewarmSimulationWorker } from "./socket.mjs";

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

let database;
async function savedFolderRequest(mode, operation) {
  if (!globalThis.indexedDB) return;
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("issie-web-directory-handles", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("folders");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      database = undefined;
      throw error;
    });
  }
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("folders", mode);
    const request = operation(tx.objectStore("folders"));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || new Error("Saved folder transaction aborted."));
  });
}

async function savedDirectory(path) {
  // New projects can live under the directory originally chosen with Browse.
  for (let root = path; root.startsWith("/local/"); root = root.slice(0, root.lastIndexOf("/"))) {
    const saved = await savedFolderRequest("readonly", store => store.get(root));
    if (saved) return saved;
  }
}

function showRecentHelp(status, beforeBrowse, afterBrowse) {
  const browse = document.createElement("strong");
  browse.textContent = "Open project → Browse...";
  const hint = document.createElement("small");
  hint.className = "help";
  hint.textContent = "Click × to remove this entry from the list.";
  status.replaceChildren(beforeBrowse, browse, afterBrowse, hint);
}

async function openRecent(path, item, open) {
  const target = normal(path);
  if (!target.startsWith("/local/")) { open(path); return; }

  const status = document.createElement("div");
  status.className = "is-size-6 px-3 pb-2";
  status.setAttribute("role", "status");
  item.after(status);
  const opening = "Opening…";
  status.textContent = opening;

  // A later click can open another menu over the still-connected startup row.
  const selection = new AbortController();
  let permissionTimer;
  const cancel = () => {
    clearTimeout(permissionTimer);
    status.remove();
    selection.abort();
  };
  window.addEventListener("click", cancel, { capture: true, signal: selection.signal });
  window.addEventListener("hashchange", cancel, { signal: selection.signal });
  const stillSelected = () => !selection.signal.aborted && item.isConnected;
  try {
    const mounted = workspace.owner(target);
    const saved = mounted || await savedDirectory(target);
    if (!stillSelected()) return cancel();
    if (!saved) throw new Error("Saved folder not found.");
    permissionTimer = setTimeout(() => {
      if (stillSelected()) showRecentHelp(status,
        "Still waiting for folder access. If you don’t see a permission prompt, choose ", " and select this folder again.");
    }, 3000);
    const permission = await saved.handle.requestPermission({ mode: "readwrite" });
    clearTimeout(permissionTimer);
    if (!stillSelected()) return cancel();
    if (permission !== "granted") throw new Error("Folder access is unavailable.");
    status.textContent = opening;
    if (!mounted) {
      let dir = saved.handle;
      for (const part of target.slice(saved.root.length).split("/").filter(Boolean)) {
        dir = await dir.getDirectoryHandle(part);
      }
      if (!stillSelected()) return cancel();
      await workspace.mount(target, dir);
    }
    if (stillSelected()) open(path);
  } catch {
    clearTimeout(permissionTimer);
    if (stillSelected()) {
      showRecentHelp(status, "Couldn’t reopen this project. Choose ", " and select the project folder again.");
      return; // Keep the guidance until the next selection.
    }
  }
  cancel();
}

async function pickFolder(start) {
  try {
    if (window.showDirectoryPicker) {
      const handle = await window.showDirectoryPicker({ mode: "readwrite", ...pickerOptions(start) });
      const folders = await savedFolderRequest("readonly", store => store.getAll())
        .catch(error => report("Could not read saved folders. " + error.message));
      const root = await workspace.attach(handle, folders);
      const mount = workspace.owner(root);
      if (mount.root.startsWith("/local/")) {
        await savedFolderRequest("readwrite", store => store.put({ root: mount.root, handle: mount.handle }, mount.root))
          .catch(error => report("Could not remember this folder. " + error.message));
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
let warmupRequested = false;
const host = {
  pickFolder, pickSheets, openRecent,
  projectChanged(path, changed) {
    path = path ? normal(path) : null;
    if (current !== path) workspace.release(current);
    current = path; dirty = changed;
    if (current && !warmupRequested) {
      warmupRequested = true;
      // Elmish batches the canvas render into a frame. Give it a paint before starting .NET.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (current) prewarmSimulationWorker();
        else warmupRequested = false;
      }));
    }
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
      const hash = location.hash;
      if (!hash.startsWith("#project=")) return;
      try {
        const moduleUrl = new URL("static/project-link.mjs", document.baseURI);
        const { decodeProjectFragment } = await import(/* webpackIgnore: true */ moduleUrl.href);
        const project = await decodeProjectFragment(hash);
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
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(error => report("Could not enable offline use. " + error.message));
  }
}
start().catch(error => { document.getElementById("app").textContent = "Could not open Issie. " + error.message; });
