const listeners = new Map();
let activeMenu = null;
let activeMenuCleanup = null;

const contextMenus = {
  SheetMenuBreadcrumbDev: ["Rename", "Delete", "Lock", "Unlock", "Lock Subtree", "Unlock Subtree"],
  SheetMenuBreadcrumb: ["Rename", "Delete"],
  CustomComponent: ["Go to sheet", "Properties"],
  ScalingBox: [
    "Rotate Clockwise (Ctrl+Right)",
    "Rotate AntiClockwise (Ctrl+Left)",
    "Flip Vertical (Ctrl+Up)",
    "Flip Horizontal (Ctrl+Down)",
    "Delete Box (DEL)",
    "Copy Box (Ctrl+C)",
    "Move Box (Drag any component)",
  ],
  Component: [
    "Rotate Clockwise (Ctrl+Right)",
    "Rotate AntiClockwise (Ctrl+Left)",
    "Flip Vertical (Ctrl+Up)",
    "Flip Horizontal (Ctrl+Down)",
    "Delete (DEL)",
    "Copy (Ctrl+C)",
    "Properties",
  ],
  Canvas: [
    "Zoom-in (Alt+Up) and centre",
    "Zoom-out (Alt+Down)",
    "Fit to window (Ctrl+W)",
    "Paste (Ctrl+V)",
    "Reroute all wires",
    "Properties",
  ],
  Wire: ["Unfix Wire"],
  WaveSimHelp: ["Waveform and RAM selection", "Waveform Operations", "Miscellaneous"],
};

function getHandlers(channel) {
  if (!listeners.has(channel)) {
    listeners.set(channel, []);
  }

  return listeners.get(channel);
}

function emit(channel, payload) {
  for (const handler of getHandlers(channel)) {
    handler({}, payload);
  }
}

function dispatchContextMenuCommand(menuType, item) {
  window.dispatchEvent(new CustomEvent("issie-context-menu-command", {
    detail: [menuType, item],
  }));
}

function dismissMenu() {
  if (activeMenuCleanup) {
    activeMenuCleanup();
    activeMenuCleanup = null;
  }

  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

function createMenuButton(menuType, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = item;
  button.style.display = "block";
  button.style.width = "100%";
  button.style.padding = "8px 12px";
  button.style.border = "0";
  button.style.background = "transparent";
  button.style.color = "#10233e";
  button.style.textAlign = "left";
  button.style.font = "13px Segoe UI, sans-serif";
  button.style.cursor = "pointer";

  button.addEventListener("mouseenter", () => {
    button.style.background = "#e7eefc";
  });

  button.addEventListener("mouseleave", () => {
    button.style.background = "transparent";
  });

  let handled = false;
  const selectItem = (event) => {
    if (handled) {
      return;
    }

    handled = true;
    event.preventDefault();
    event.stopPropagation();
    dismissMenu();
    dispatchContextMenuCommand(menuType, item);
  };

  button.addEventListener("pointerdown", selectItem);
  button.addEventListener("click", selectItem);

  return button;
}

function showContextMenu(menuType, clientX, clientY) {
  dismissMenu();

  const items = contextMenus[menuType] || [];
  if (items.length === 0) {
    return;
  }

  const menu = document.createElement("div");
  menu.style.position = "fixed";
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.style.minWidth = "220px";
  menu.style.maxWidth = "320px";
  menu.style.padding = "6px 0";
  menu.style.background = "#ffffff";
  menu.style.border = "1px solid #c9d5ef";
  menu.style.borderRadius = "10px";
  menu.style.boxShadow = "0 16px 40px rgba(16, 35, 62, 0.18)";
  menu.style.zIndex = "99999";

  for (const item of items) {
    menu.appendChild(createMenuButton(menuType, item));
  }

  const closeMenu = (event) => {
    if (event && menu.contains(event.target)) {
      return;
    }

    dismissMenu();
  };

  activeMenu = menu;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
  }
  if (rect.bottom > window.innerHeight - 8) {
    menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
  }

  window.addEventListener("pointerdown", closeMenu, true);
  window.addEventListener("blur", closeMenu, true);
  window.addEventListener("scroll", closeMenu, true);
  activeMenuCleanup = () => {
    window.removeEventListener("pointerdown", closeMenu, true);
    window.removeEventListener("blur", closeMenu, true);
    window.removeEventListener("scroll", closeMenu, true);
  };
}

const ipcRenderer = {
  eventNames() {
    return Array.from(listeners.keys());
  },
  listeners(channel) {
    return [...getHandlers(channel)];
  },
  on(channel, handler) {
    getHandlers(channel).push(handler);
    return ipcRenderer;
  },
  send(channel, ...args) {
    if (channel === "exit-the-app") {
      window.close();
      return;
    }

    if (channel === "show-context-menu") {
      const values = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
      const menuType = `${values[0] || ""}`;
      const clientX = Number(values[1] || 0);
      const clientY = Number(values[2] || 0);
      showContextMenu(menuType, clientX, clientY);
    }
  },
  sendSync(channel) {
    if (channel === "get-user-data") {
      return "";
    }

    return undefined;
  },
};

const shell = {
  openExternal(url) {
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  },
};

const webFrame = {
  clearCache() {},
  getResourceUsage() {
    return {};
  },
};

module.exports = {
  app: {
    commandLine: {
      hasSwitch() {
        return false;
      },
    },
  },
  ipcRenderer,
  shell,
  webFrame,
};

