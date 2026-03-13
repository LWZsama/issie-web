const browserFiles = require("./browser-files.js");

const filePrefix = "__issie_vfs_file__:";
const dirPrefix = "__issie_vfs_dir__:";
const manifestCache = new Map();

function normalizePath(inputPath) {
  return browserFiles.normalizePath(inputPath);
}

function fileKey(filePath) {
  return `${filePrefix}${normalizePath(filePath)}`;
}

function dirKey(dirPath) {
  return `${dirPrefix}${normalizePath(dirPath)}`;
}

function dirname(filePath) {
  const normalized = normalizePath(filePath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}

function basename(filePath) {
  const normalized = normalizePath(filePath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash < 0 ? normalized : normalized.slice(lastSlash + 1);
}

function ensureDirectory(path) {
  browserFiles.ensureDirectory(path);
}

function toHttpPath(inputPath) {
  return `${inputPath || ""}`.replace(/\\/g, "/").replace(/\/$/, "");
}

function readHttpFile(filePath) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", toHttpPath(filePath), false);
  xhr.send(null);

  if (xhr.status >= 200 && xhr.status < 300) {
    return xhr.responseText;
  }

  throw new Error(`File '${filePath}' does not exist`);
}

function tryReadHttpFile(filePath) {
  try {
    return readHttpFile(filePath);
  } catch (_error) {
    return null;
  }
}

function readHttpDirectoryManifest(folderPath) {
  const normalizedFolder = normalizePath(folderPath);

  if (manifestCache.has(normalizedFolder)) {
    return manifestCache.get(normalizedFolder);
  }

  const manifestPath = `${toHttpPath(folderPath)}/index.json`;
  const payload = tryReadHttpFile(manifestPath);

  if (!payload) {
    manifestCache.set(normalizedFolder, null);
    return null;
  }

  try {
    const parsed = JSON.parse(payload);
    const manifest = Array.isArray(parsed) ? parsed : null;
    manifestCache.set(normalizedFolder, manifest);
    return manifest;
  } catch (_error) {
    manifestCache.set(normalizedFolder, null);
    return null;
  }
}

function hasHttpEntry(targetPath) {
  const parentManifest = readHttpDirectoryManifest(dirname(targetPath));

  if (!parentManifest) {
    return null;
  }

  return parentManifest.includes(basename(targetPath));
}

function listEntries(folderPath) {
  const normalizedFolder = normalizePath(folderPath);
  const prefix = normalizedFolder === "/" ? "/" : `${normalizedFolder}/`;
  const entries = new Set();

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);

    if (!key || (!key.startsWith(filePrefix) && !key.startsWith(dirPrefix))) {
      continue;
    }

    const path = key.startsWith(filePrefix)
      ? key.slice(filePrefix.length)
      : key.slice(dirPrefix.length);

    if (!path.startsWith(prefix) || path === normalizedFolder) {
      continue;
    }

    const remainder = path.slice(prefix.length);
    const [entry] = remainder.split("/");

    if (entry) {
      entries.add(entry);
    }
  }

  if (entries.size > 0) {
    return Array.from(entries);
  }

  return readHttpDirectoryManifest(folderPath) || [];
}

module.exports = {
  existsSync(targetPath) {
    const normalized = normalizePath(targetPath);

    if (localStorage.getItem(fileKey(normalized)) !== null) {
      return true;
    }

    if (localStorage.getItem(dirKey(normalized)) !== null) {
      return true;
    }

    const httpEntry = hasHttpEntry(targetPath);
    if (httpEntry !== null) {
      return httpEntry;
    }

    if (readHttpDirectoryManifest(targetPath)) {
      return true;
    }

    return tryReadHttpFile(targetPath) !== null;
  },
  mkdirSync(folderPath) {
    ensureDirectory(folderPath);
  },
  readFileSync(filePath) {
    const normalized = normalizePath(filePath);
    const stored = localStorage.getItem(fileKey(normalized));

    if (stored !== null) {
      return stored;
    }

    return readHttpFile(filePath);
  },
  readdirSync(folderPath) {
    return listEntries(folderPath);
  },
  renameSync(oldPath, newPath) {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    const oldValue = localStorage.getItem(fileKey(normalizedOld));

    if (oldValue !== null) {
      browserFiles.setVirtualFile(normalizedNew, oldValue);
      localStorage.removeItem(fileKey(normalizedOld));
      return;
    }

    const oldDirMarker = localStorage.getItem(dirKey(normalizedOld));
    if (oldDirMarker !== null) {
      localStorage.setItem(dirKey(normalizedNew), oldDirMarker);
      localStorage.removeItem(dirKey(normalizedOld));
    }
  },
  unlink(targetPath, callback) {
    const normalized = normalizePath(targetPath);
    localStorage.removeItem(fileKey(normalized));
    if (typeof callback === "function") {
      callback(undefined);
    }
  },
  writeFileSync(filePath, data) {
    const normalized = normalizePath(filePath);
    browserFiles.setVirtualFile(normalized, data);
  },
};
