// Browser implementation of the renderer bridge introduced by upstream 6.0.14.
//
// The desktop build gets window.issieBridge from Electron's preload script. The web build has no
// preload process, so install the same small surface before the generated Fable bundle executes.
// Keeping this adapter in JavaScript means future upstream Bridge.fs changes do not create an
// add/add conflict in the browser port.

const browserFiles = require("./browser-files.js");
const browserFs = require("./fs.js");
const electron = require("./electron.js");
const remote = require("./electron-remote.js");

function clipboardWrite(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(`${text}`);
    return;
  }

  const element = document.createElement("textarea");
  element.value = `${text}`;
  element.style.position = "fixed";
  element.style.opacity = "0";
  document.body.appendChild(element);
  element.select();
  try {
    document.execCommand("copy");
  } finally {
    element.remove();
  }
}

let zoomLevel = 0;
let lastContextMenuPosition = { x: 0, y: 0 };

if (typeof window !== "undefined") {
  window.addEventListener("contextmenu", (event) => {
    lastContextMenuPosition = { x: event.clientX, y: event.clientY };
  }, true);
}

const api = {
  bootstrap: {
    platform: "browser",
    staticDir: "static",
    userData: "/browser-projects",
    documents: "/documents",
    cwd: "/",
    isDev: false,
    hasDebugSwitch: false,
    hasWSwitch: false,
    logSwitch: "",
  },

  fs: {
    readFile: browserFs.readFileSync,
    writeFile: browserFs.writeFileSync,
    exists: browserFs.existsSync,
    isDirectory: browserFs.isDirectorySync,
    mkdir: browserFs.mkdirSync,
    readdir: browserFs.readdirSync,
    readdirDirectories: browserFs.readdirDirectoriesSync,
    unlink(filePath) {
      browserFs.unlink(filePath);
    },
    rename: browserFs.renameSync,
    // Browser storage has no filesystem timestamps. No current renderer caller relies on this,
    // and null is the bridge's documented answer for a missing/unknown timestamp.
    modifiedTimeMs() {
      return null;
    },
  },

  dialog: {
    open(options) {
      return remote.dialog.showOpenDialogSync({}, options) || [];
    },
    save(options) {
      return remote.dialog.showSaveDialogSync(options) || "";
    },
  },

  window: {
    getZoomLevel() {
      return zoomLevel;
    },
    setZoomLevel(level) {
      zoomLevel = Number(level) || 0;
      if (document.body) {
        document.body.style.zoom = `${Math.pow(1.2, zoomLevel)}`;
      }
    },
    toggleFullScreen() {
      if (document.fullscreenElement) {
        document.exitFullscreen?.();
      } else {
        document.documentElement.requestFullscreen?.();
      }
    },
    edit() {
      // Browser keyboard shortcuts are handled by the browser itself.
    },
  },

  openExternal(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  },

  clipboardWrite,

  revealInFileManager() {
    return Promise.resolve("");
  },

  build: {
    start() {
      return "";
    },
    status() {
      return -2;
    },
    cancel() {},
    runDevTool() {},
  },

  uart: {
    connectAndRead() {
      return Promise.reject(new Error("USB debugging is unavailable in the browser build."));
    },
    simpleConnect() {
      return Promise.reject(new Error("USB debugging is unavailable in the browser build."));
    },
    disconnect() {},
    step() {},
    pause() {},
    continue() {},
    readAllViewers() {
      return Promise.resolve([]);
    },
    stepAndReadAllViewers() {
      return Promise.resolve([]);
    },
  },

  diagnostics: {
    resourceUsage() {
      return {};
    },
    clearCache() {},
    processMemory() {
      return Promise.resolve({});
    },
    ipcListenerCounts() {
      return {};
    },
  },

  ipc: {
    quit() {
      window.close();
    },
    toggleDevTools() {},
    showContextMenu(menuType) {
      electron.ipcRenderer.send("show-context-menu", [
        menuType,
        lastContextMenuPosition.x || window.innerWidth / 2,
        lastContextMenuPosition.y || window.innerHeight / 2,
      ]);
    },
    setApplicationMenu() {},
    onClosingWindow() {},
    onWindowLostFocus() {},
    // Renderer.fs already owns the browser CustomEvent subscription. Keeping this a no-op avoids
    // dispatching every custom context-menu selection twice when the upstream subscription is also
    // present after a rebase.
    onContextMenuCommand() {},
    onApplicationMenuCommand() {},
  },
};

if (typeof window !== "undefined" && !window.issieBridge) {
  window.issieBridge = api;
}

module.exports = api;
