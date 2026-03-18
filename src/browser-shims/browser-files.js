const filePrefix = "__issie_vfs_file__:";
const dirPrefix = "__issie_vfs_dir__:";
const exportableExtensions = new Set([
  ".dgm",
  ".dgmauto",
  ".dgmnew",
  ".dprj",
  ".ram",
  ".txt",
  ".v",
]);

const rootRegistry = new Map();
const fileHandleRegistry = new Map();
const pendingSaveRegistry = new Map();
const sessionStorageKey = "__issie_browser_session__";

function normalizePath(inputPath) {
  const raw = `${inputPath || ""}`.replace(/\\/g, "/");
  const parts = raw.split("/").filter((part) => part && part !== ".");
  const stack = [];

  for (const part of parts) {
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }

  return `/${stack.join("/")}`;
}

function fileKey(filePath) {
  return `${filePrefix}${normalizePath(filePath)}`;
}

function dirKey(dirPath) {
  return `${dirPrefix}${normalizePath(dirPath)}`;
}

function basename(inputPath) {
  const normalized = normalizePath(inputPath);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

function dirname(filePath) {
  const normalized = normalizePath(filePath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}

function extname(inputPath) {
  const name = basename(inputPath);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index).toLowerCase();
}

function joinPath(...parts) {
  return normalizePath(parts.join("/"));
}

function getStoredProjectRoot(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length >= 2 && (parts[0] === "browser-projects" || parts[0] === "browser-imports" || parts[0] === "demos")) {
    return `/${parts[0]}/${parts[1]}`;
  }

  return null;
}

function listStoredProjectRoots() {
  const roots = new Set();

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);

    if (!key || (!key.startsWith(filePrefix) && !key.startsWith(dirPrefix))) {
      continue;
    }

    const path = key.startsWith(filePrefix)
      ? key.slice(filePrefix.length)
      : key.slice(dirPrefix.length);
    const rootPath = getStoredProjectRoot(path);

    if (rootPath) {
      roots.add(rootPath);
    }
  }

  return Array.from(roots);
}

function setStorageItem(key, value, keepRoots = []) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      throw error;
    }

    clearStoredData({ keepRoots, clearSession: false });
    localStorage.setItem(key, value);
  }
}

function ensureDirectory(path) {
  const keepRoots = [];
  const rootPath = getStoredProjectRoot(path);

  if (rootPath) {
    keepRoots.push(rootPath);
  }

  let current = normalizePath(path);

  while (current && current !== "/") {
    setStorageItem(dirKey(current), "1", keepRoots);
    current = dirname(current);
  }

  setStorageItem(dirKey("/"), "1", keepRoots);
}

function setVirtualFile(filePath, data) {
  const normalized = normalizePath(filePath);
  const rootPath = getStoredProjectRoot(normalized);
  const keepRoots = rootPath ? [rootPath] : [];

  ensureDirectory(dirname(normalized));
  setStorageItem(fileKey(normalized), `${data}`, keepRoots);
}

function getVirtualFile(filePath) {
  return localStorage.getItem(fileKey(filePath));
}

function removeVirtualFile(filePath) {
  localStorage.removeItem(fileKey(filePath));
}

function clearVirtualRoot(rootPath) {
  const normalizedRoot = normalizePath(rootPath);
  const keysToRemove = [];

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);

    if (!key || (!key.startsWith(filePrefix) && !key.startsWith(dirPrefix))) {
      continue;
    }

    const path = key.startsWith(filePrefix)
      ? key.slice(filePrefix.length)
      : key.slice(dirPrefix.length);

    if (path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }

  for (const storedPath of Array.from(fileHandleRegistry.keys())) {
    if (storedPath === normalizedRoot || storedPath.startsWith(`${normalizedRoot}/`)) {
      fileHandleRegistry.delete(storedPath);
    }
  }

  rootRegistry.delete(normalizedRoot);
}

function sanitizeSegment(name, fallback) {
  const cleaned = `${name || ""}`
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || fallback;
}

function createProjectRoot(folderName) {
  return joinPath("/browser-projects", sanitizeSegment(folderName, `project_${Date.now()}`));
}

function createImportRoot() {
  return joinPath("/browser-imports", `import-${Date.now()}`);
}

function registerRoot(rootPath, metadata) {
  rootRegistry.set(normalizePath(rootPath), { ...metadata });
}

function findRootMetadata(filePath) {
  const normalized = normalizePath(filePath);
  let match = null;

  for (const [rootPath, metadata] of rootRegistry.entries()) {
    if (normalized === rootPath || normalized.startsWith(`${rootPath}/`)) {
      if (!match || rootPath.length > match.rootPath.length) {
        match = { rootPath, metadata };
      }
    }
  }

  return match;
}

function relativePath(rootPath, filePath) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedFile = normalizePath(filePath);

  if (normalizedFile === normalizedRoot) {
    return "";
  }

  return normalizedFile.slice(normalizedRoot.length + 1);
}

function isAbortError(error) {
  return error && (error.name === "AbortError" || error.code === 20);
}

function isQuotaExceededError(error) {
  return error && (
    error.name === "QuotaExceededError" ||
    error.code === 22 ||
    error.code === 1014
  );
}

function clearStoredData(options = {}) {
  const keep = new Set((options.keepRoots || []).map(normalizePath));

  for (const rootPath of listStoredProjectRoots()) {
    if (!keep.has(rootPath)) {
      clearVirtualRoot(rootPath);
    }
  }

  if (options.clearSession !== false) {
    localStorage.removeItem(sessionStorageKey);
  }
}

function resetBrowserStorageOnStartup() {
  const keysToRemove = [];

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);

    if (!key) {
      continue;
    }

    if (key.startsWith(filePrefix) || key.startsWith(dirPrefix) || key === sessionStorageKey) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }

  rootRegistry.clear();
  fileHandleRegistry.clear();
  pendingSaveRegistry.clear();
}

function clearStoredPath(path) {
  const normalizedPath = normalizePath(path);
  const rootPath = getStoredProjectRoot(normalizedPath) || normalizedPath;
  clearVirtualRoot(rootPath);
}

async function cleanupStorageIfNeeded(keepRoots = []) {
  return true;
}

function shouldPersistExternally(filePath) {
  const normalized = normalizePath(filePath);
  const match = findRootMetadata(normalized);

  if (!match) {
    return false;
  }

  if (relativePath(match.rootPath, normalized).startsWith("backup/")) {
    return false;
  }

  return exportableExtensions.has(extname(normalized));
}

async function writeToFileHandle(handle, data) {
  const writable = await handle.createWritable();
  await writable.write(`${data}`);
  await writable.close();
}

async function ensureFileHandleForDirectoryRoot(rootPath, filePath, directoryHandle) {
  const normalizedFilePath = normalizePath(filePath);
  const cached = fileHandleRegistry.get(normalizedFilePath);

  if (cached) {
    return cached;
  }

  const parts = relativePath(rootPath, normalizedFilePath)
    .split("/")
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  let currentHandle = directoryHandle;

  for (let i = 0; i < parts.length - 1; i += 1) {
    currentHandle = await currentHandle.getDirectoryHandle(parts[i], { create: true });
  }

  const fileHandle = await currentHandle.getFileHandle(parts[parts.length - 1], { create: true });
  fileHandleRegistry.set(normalizedFilePath, fileHandle);
  return fileHandle;
}

function downloadFile(filePath, data) {
  const blob = new Blob([`${data}`], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = basename(filePath);
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function promptForStandaloneFileHandle(filePath) {
  if (typeof window.showSaveFilePicker !== "function") {
    return null;
  }

  const extension = extname(filePath);
  const options = { suggestedName: basename(filePath) };

  if (extension) {
    options.types = [{
      description: "Issie file",
      accept: {
        "application/octet-stream": [extension],
      },
    }];
  }

  const handle = await window.showSaveFilePicker(options);

  if (handle) {
    fileHandleRegistry.set(normalizePath(filePath), handle);
  }

  return handle;
}

async function persistVirtualFile(filePath, data) {
  const normalized = normalizePath(filePath);
  const rootMatch = findRootMetadata(normalized);

  if (!rootMatch) {
    return;
  }

  const { rootPath, metadata } = rootMatch;
  const existingHandle = fileHandleRegistry.get(normalized);

  try {
    if (existingHandle) {
      await writeToFileHandle(existingHandle, data);
      return;
    }

    if (metadata.directoryHandle) {
      const fileHandle = await ensureFileHandleForDirectoryRoot(rootPath, normalized, metadata.directoryHandle);

      if (fileHandle) {
        await writeToFileHandle(fileHandle, data);
      }

      return;
    }

    if (metadata.promptOnSave) {
      const fileHandle = await promptForStandaloneFileHandle(normalized);

      if (fileHandle) {
        await writeToFileHandle(fileHandle, data);
        return;
      }
    }

    downloadFile(normalized, data);
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("Unable to persist browser file", normalized, error);
      downloadFile(normalized, data);
    }
  }
}

function scheduleExternalSave(filePath, data) {
  const normalized = normalizePath(filePath);

  if (!shouldPersistExternally(normalized)) {
    return;
  }

  const pending = pendingSaveRegistry.get(normalized) || Promise.resolve();
  const next = pending
    .catch(() => undefined)
    .then(() => persistVirtualFile(normalized, data));

  pendingSaveRegistry.set(normalized, next.finally(() => {
    if (pendingSaveRegistry.get(normalized) === next) {
      pendingSaveRegistry.delete(normalized);
    }
  }));
}

async function persistFile(filePath) {
  const normalized = normalizePath(filePath);
  const data = getVirtualFile(normalized);

  if (data === null || !shouldPersistExternally(normalized)) {
    return;
  }

  await persistVirtualFile(normalized, data);
}

async function removeExternalFile(filePath) {
  const normalized = normalizePath(filePath);
  const rootMatch = findRootMetadata(normalized);

  if (!rootMatch || !rootMatch.metadata.directoryHandle) {
    fileHandleRegistry.delete(normalized);
    return;
  }

  const relPath = relativePath(rootMatch.rootPath, normalized)
    .split("/")
    .filter(Boolean);

  if (relPath.length === 0) {
    return;
  }

  let currentHandle = rootMatch.metadata.directoryHandle;

  for (let i = 0; i < relPath.length - 1; i += 1) {
    currentHandle = await currentHandle.getDirectoryHandle(relPath[i], { create: false });
  }

  await currentHandle.removeEntry(relPath[relPath.length - 1]);
  fileHandleRegistry.delete(normalized);
}

function scheduleExternalDelete(filePath) {
  removeExternalFile(filePath).catch((error) => {
    if (!isAbortError(error)) {
      console.error("Unable to delete browser file", filePath, error);
    }
  });
}

function scheduleExternalRename(oldPath, newPath, nextData) {
  scheduleExternalSave(newPath, nextData);
  scheduleExternalDelete(oldPath);
}

async function readTextFile(fileLike) {
  if (typeof fileLike.text === "function") {
    return fileLike.text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsText(fileLike);
  });
}

function shouldSkipImportedProjectEntry(pathParts) {
  return pathParts.some((part) => `${part}`.toLowerCase() === "backup");
}

function keepRootsFromSessionSnapshot(serializedSnapshot) {
  if (!serializedSnapshot) {
    return [];
  }

  try {
    const snapshot = JSON.parse(serializedSnapshot);
    return snapshot && snapshot.ProjectPath ? [snapshot.ProjectPath] : [];
  } catch (_error) {
    return [];
  }
}

async function populateProjectFromDirectoryHandle(
  directoryHandle,
  rootPath,
  currentPath = rootPath,
  relativeParts = [],
) {
  ensureDirectory(currentPath);

  for await (const [entryName, entry] of directoryHandle.entries()) {
    const entryParts = [...relativeParts, entryName];
    if (shouldSkipImportedProjectEntry(entryParts)) {
      continue;
    }

    const targetPath = joinPath(currentPath, entryName);

    if (entry.kind === "directory") {
      ensureDirectory(targetPath);
      await populateProjectFromDirectoryHandle(entry, rootPath, targetPath, entryParts);
    } else if (entry.kind === "file") {
      const file = await entry.getFile();
      const text = await readTextFile(file);
      setVirtualFile(targetPath, text);
      fileHandleRegistry.set(normalizePath(targetPath), entry);
    }
  }
}

async function populateProjectFromInputFiles(files, rootPath) {
  ensureDirectory(rootPath);

  for (const file of files) {
    const relPath = `${file.webkitRelativePath || file.name}`
      .split("/")
      .filter(Boolean);
    const pathWithinRoot = relPath.length > 1 ? relPath.slice(1) : relPath;

    if (shouldSkipImportedProjectEntry(pathWithinRoot)) {
      continue;
    }

    const targetPath = joinPath(rootPath, pathWithinRoot.join("/"));
    const text = await readTextFile(file);

    setVirtualFile(targetPath, text);
  }
}

async function chooseProjectFileWithPicker() {
  const handles = await window.showOpenFilePicker({
    multiple: false,
    types: [{
      description: "Issie project file",
      accept: {
        "application/json": [".dprj"],
      },
    }],
  });

  return handles && handles.length > 0 ? handles[0] : null;
}

async function chooseProjectFileWithInput() {
  const files = await chooseFilesWithInput(".dprj", false);
  return files.length > 0 ? files[0] : null;
}

async function chooseDirectoryForProjectFile(projectFileHandle) {
  const options = { mode: "readwrite" };

  if (projectFileHandle) {
    options.startIn = projectFileHandle;
  }

  let directoryHandle;

  try {
    directoryHandle = await window.showDirectoryPicker(options);
  } catch (error) {
    if (isAbortError(error) || !projectFileHandle) {
      throw error;
    }

    directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  }

  if (projectFileHandle && projectFileHandle.name) {
    await directoryHandle.getFileHandle(projectFileHandle.name, { create: false });
  }

  return directoryHandle;
}

function chooseDirectoryWithInput() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.style.display = "none";

    const cleanup = () => {
      input.value = "";
      input.remove();
    };

    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      cleanup();
      resolve(files);
    }, { once: true });

    input.addEventListener("cancel", () => {
      cleanup();
      resolve([]);
    }, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}

function chooseFilesWithInput(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";

    const cleanup = () => {
      input.value = "";
      input.remove();
    };

    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      cleanup();
      resolve(files);
    }, { once: true });

    input.addEventListener("cancel", () => {
      cleanup();
      resolve([]);
    }, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}

async function loadBundledDemo(sourcePath, targetPath) {
  const response = await fetch(`${sourcePath.replace(/\\/g, "/")}/demo.json`, { cache: "force-cache" });

  if (!response.ok) {
    return false;
  }

  const bundle = await response.json();
  if (!bundle || typeof bundle !== "object" || !bundle.files || typeof bundle.files !== "object") {
    return false;
  }

  clearStoredPath(targetPath);
  ensureDirectory(targetPath);

  for (const [fileName, fileContents] of Object.entries(bundle.files)) {
    setVirtualFile(joinPath(targetPath, fileName), `${fileContents ?? ""}`);
  }

  return true;
}

async function createProjectDirectory() {
  try {
    if (typeof window.showDirectoryPicker === "function") {
      const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      const rootPath = createProjectRoot(directoryHandle.name);

      clearVirtualRoot(rootPath);
      registerRoot(rootPath, {
        directoryHandle,
        promptOnSave: false,
        label: directoryHandle.name,
      });

      await cleanupStorageIfNeeded([rootPath]);
      await populateProjectFromDirectoryHandle(directoryHandle, rootPath);
      return rootPath;
    }

    const rootPath = createProjectRoot(`project_${Date.now()}`);
    clearVirtualRoot(rootPath);
    ensureDirectory(rootPath);
    registerRoot(rootPath, {
      directoryHandle: null,
      promptOnSave: true,
      label: basename(rootPath),
    });
    return rootPath;
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }

    throw error;
  }
}

async function openProjectDirectory() {
  try {
    if (typeof window.showDirectoryPicker === "function") {
      const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      let projectFileName = null;

      for await (const [entryName, entry] of directoryHandle.entries()) {
        if (entry.kind === "file" && extname(entryName) === ".dprj") {
          projectFileName = entryName;
          break;
        }
      }

      if (!projectFileName) {
        throw new Error("Selected folder does not contain an Issie .dprj file");
      }

      const rootPath = createProjectRoot(directoryHandle.name);

      clearVirtualRoot(rootPath);
      registerRoot(rootPath, {
        directoryHandle,
        promptOnSave: false,
        label: directoryHandle.name,
      });

      await cleanupStorageIfNeeded([rootPath]);
      await populateProjectFromDirectoryHandle(directoryHandle, rootPath);
      return rootPath;
    }

    const files = await chooseDirectoryWithInput();

    if (files.length === 0) {
      return null;
    }

    const containsProjectFile = files.some((file) => {
      const relPath = `${file.webkitRelativePath || file.name}`
        .split("/")
        .filter(Boolean);
      const pathWithinRoot = relPath.length > 1 ? relPath.slice(1) : relPath;

      return pathWithinRoot.length === 1 && extname(pathWithinRoot[0]) === ".dprj";
    });

    if (!containsProjectFile) {
      throw new Error("Selected folder does not contain an Issie .dprj file");
    }

    const rootName =
      ((files[0].webkitRelativePath || "").split("/").filter(Boolean)[0]) ||
      "project";
    const rootPath = createProjectRoot(rootName);

    clearVirtualRoot(rootPath);
    registerRoot(rootPath, {
      directoryHandle: null,
      promptOnSave: true,
      label: rootName,
    });

    await cleanupStorageIfNeeded([rootPath]);
    await populateProjectFromInputFiles(files, rootPath);
    return rootPath;
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }

    throw error;
  }
}

async function openSheetFiles() {
  try {
    const rootPath = createImportRoot();
    clearVirtualRoot(rootPath);
    registerRoot(rootPath, {
      directoryHandle: null,
      promptOnSave: false,
      label: "import",
    });

    await cleanupStorageIfNeeded([rootPath]);

    if (typeof window.showOpenFilePicker === "function") {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: "Issie sheets",
          accept: {
            "application/json": [".dgm"],
          },
        }],
      });

      if (!handles || handles.length === 0) {
        return null;
      }

      const filePaths = [];

      for (const handle of handles) {
        const file = await handle.getFile();
        const targetPath = joinPath(rootPath, handle.name);
        const text = await readTextFile(file);

        setVirtualFile(targetPath, text);
        filePaths.push(targetPath);
      }

      return filePaths;
    }

    const files = await chooseFilesWithInput(".dgm", true);

    if (files.length === 0) {
      return null;
    }

    const filePaths = [];

    for (const file of files) {
      const targetPath = joinPath(rootPath, file.name);
      const text = await readTextFile(file);

      setVirtualFile(targetPath, text);
      filePaths.push(targetPath);
    }

    return filePaths;
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }

    throw error;
  }
}

function commitSessionSnapshot(serializedSnapshot) {
  localStorage.removeItem(sessionStorageKey);
}

function queueSessionSnapshotCommit() {
  commitSessionSnapshot(null);
}

function saveSessionSnapshot(serializedSnapshot) {
  commitSessionSnapshot(null);
}

function loadSessionSnapshot() {
  return null;
}

function clearSessionSnapshot() {
  commitSessionSnapshot(null);
}

function beginSessionRestore() {
  commitSessionSnapshot(null);
}

function endSessionRestore() {
  commitSessionSnapshot(null);
}

const api = {
  basename,
  beginSessionRestore,
  cleanupStorageIfNeeded,
  clearStoredPath,
  clearSessionSnapshot,
  clearStoredData,
  createProjectDirectory,
  dirname,
  endSessionRestore,
  ensureDirectory,
  fileKey,
  getVirtualFile,
  joinPath,
  loadSessionSnapshot,
  loadBundledDemo,
  normalizePath,
  openProjectDirectory,
  openSheetFiles,
  persistFile,
  removeVirtualFile,
  saveSessionSnapshot,
  scheduleExternalDelete,
  scheduleExternalRename,
  scheduleExternalSave,
  setVirtualFile,
};

if (typeof window !== "undefined") {
  resetBrowserStorageOnStartup();
  window.__issieBrowserFiles = api;
}

module.exports = api;










