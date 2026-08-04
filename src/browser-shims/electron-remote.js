const defaultDocumentsPath = "/documents";

function normalizeMenuItem(item) {
  const normalized = { ...item };
  if (normalized.visible === undefined) {
    normalized.visible = true;
  }

  if (Array.isArray(normalized.submenu)) {
    normalized.submenu = normalized.submenu.map(normalizeMenuItem);
  }

  return normalized;
}

const app = {
  applicationMenu: undefined,
  commandLine: {
    hasSwitch() {
      return false;
    },
  },
  getPath() {
    return defaultDocumentsPath;
  },
};

const Menu = {
  buildFromTemplate(template) {
    return {
      items: Array.isArray(template) ? template.map(normalizeMenuItem) : [],
      popup() {
        return undefined;
      },
    };
  },
};

const dialog = {
  showOpenDialogSync(_windowHandle, options = {}) {
    const promptText = options.title || options.nameFieldLabel || "Enter a path";
    const defaultPath = options.defaultPath || "";
    const result = window.prompt(promptText, defaultPath);

    if (!result) {
      return undefined;
    }

    const isMultiSelect = Array.isArray(options.properties) &&
      options.properties.includes("multiSelections");

    return isMultiSelect
      ? result.split(";").map((item) => item.trim()).filter(Boolean)
      : [result];
  },
  showSaveDialogSync(options = {}) {
    const promptText = options.title || options.nameFieldLabel || "Enter a path";
    const defaultPath = options.defaultPath || "";
    const result = window.prompt(promptText, defaultPath);
    return result || undefined;
  },
  showErrorBox(title, message) {
    window.alert(`${title}\n\n${message}`);
  },
};

module.exports = {
  Menu,
  app,
  dialog,
  getCurrentWindow() {
    return {};
  },
};
