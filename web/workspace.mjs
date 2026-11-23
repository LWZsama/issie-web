// The renderer reads synchronously. Mount a directory before handing it to Issie and serialize
// subsequent disk operations in the order the desktop filesystem would have observed them.
const parent = path => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = path => path.slice(path.lastIndexOf("/") + 1);
const child = (path, name) => (path === "/" ? "" : path) + "/" + name;
const within = (path, root) => path === root || path.startsWith(root + "/");
const projectFile = /\.(dgm|ldgm|dprj|dgmauto|dgmnew|ram|v|sv|vh|txt|json)$/i;
const directory = () => ({ time: Date.now() });

export function normal(path) {
  const parts = [];
  for (const part of String(path).replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
}

async function diskParent(handle, relative) {
  const parts = relative.split("/");
  const name = parts.pop();
  for (const part of parts) handle = await handle.getDirectoryHandle(part);
  return [handle, name];
}

function diskWrite(entry, fresh = false) {
  // Keep a newly created handle if writing it fails. A retry may update our own partial file,
  // but must still refuse a file that appeared independently after the directory was mounted.
  let file;
  return async (handle, relative) => {
    if (!file) {
      const [dir, name] = await diskParent(handle, relative);
      if (fresh) {
        try {
          if (entry.text === undefined) await dir.getDirectoryHandle(name);
          else await dir.getFileHandle(name);
          throw new Error(`'${name}' already exists in the selected folder.`);
        } catch (error) {
          if (error.name !== "NotFoundError") throw error;
        }
      }
      if (entry.text === undefined) {
        await dir.getDirectoryHandle(name, { create: true });
        return;
      }
      file = await dir.getFileHandle(name, { create: true });
    }
    const writer = await file.createWritable();
    try {
      await writer.write(entry.text);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
  };
}

async function eraseDisk(handle, relative) {
  try {
    const [dir, name] = await diskParent(handle, relative);
    await dir.removeEntry(name);
  }
  catch (error) { if (error.name !== "NotFoundError") throw error; }
}

export class Workspace {
  entries = new Map([["/", directory()]]);
  mounts = new Map();
  unexported = new Set();
  nextId = 0;

  constructor(report) {
    this.report = report;
    for (const path of ["/Documents", "/userData", "/local", "/shared", "/imports", "/downloads", "/static"]) {
      this.entries.set(path, directory());
    }
  }

  populate(root, files) {
    this.entries.set(root, directory());
    for (const [relative, text] of Object.entries(files)) {
      const path = normal(child(root, relative));
      if (!within(path, root) || path === root) throw new Error("Invalid project path.");
      for (let dir = parent(path); !this.entries.has(dir); dir = parent(dir)) this.entries.set(dir, directory());
      this.entries.set(path, { text, time: Date.now() });
    }
  }

  workingCopy(project) {
    const group = child("/shared", String(++this.nextId));
    this.entries.set(group, directory());
    const root = child(group, project.name);
    this.populate(root, project.files);
    if (!this.list(root).some(name => /\.dprj$/i.test(name))) this.write(child(root, project.name + ".dprj"), "");
    this.unexported.delete(root);
    return root;
  }

  release(root) {
    if (!root?.startsWith("/shared/")) return;
    const remove = () => {
      for (const path of this.entries.keys()) if (within(path, parent(root))) this.entries.delete(path);
      this.mounts.delete(root);
      this.unexported.delete(root);
    };
    const mount = this.mounts.get(root);
    if (mount?.jobs.length) this.flush(mount).then(remove, () => {});
    else remove();
  }

  read(path) {
    const text = this.entries.get(normal(path))?.text;
    if (text === undefined) throw new Error(`Cannot read file '${path}'.`);
    return text;
  }

  isDirectory(path) {
    const entry = this.entries.get(normal(path));
    return !!entry && entry.text === undefined;
  }

  list(path) {
    const dir = normal(path);
    return Array.from(this.entries.keys()).filter(p => p !== dir && parent(p) === dir).map(nameOf).sort();
  }

  browse(path) {
    path = normal(path);
    // Upstream polls the folder currently displayed in its project chooser. Refresh only that
    // subtree and keep the last complete listing available to synchronous renders in the meantime.
    const mount = this.owner(path);
    if (mount && !mount.refresh && !mount.jobs.length && Date.now() - mount.scannedAt >= 1000) {
      mount.scannedAt = Date.now();
      mount.refresh = this.mount(mount.root, mount.handle, path, true).catch(error => {
        if (error.message !== mount.scanError) this.report(error.message);
        mount.scanError = error.message;
      }).finally(() => { mount.refresh = null; });
    }
    const entries = this.list(path).filter(name => this.isDirectory(child(path, name))).map(name => {
      const dir = child(path, name);
      const names = this.list(dir);
      return { path: dir, hasMarker: names.some(n => /\.dprj$/i.test(n)),
        sheetCount: names.filter(n => /\.dgm$/i.test(n)).length,
        componentCount: names.filter(n => /\.ldgm$/i.test(n)).length };
    });
    return { exists: this.isDirectory(path), entries };
  }

  owner(path) {
    let dir = normal(path);
    while (dir !== "/") {
      if (this.mounts.has(dir)) return this.mounts.get(dir);
      dir = parent(dir);
    }
  }

  enqueue(path, action) {
    const mount = this.owner(path);
    if (!mount) {
      if (path.startsWith("/shared/") && !path.includes("/backup/")) {
        this.unexported.add(path.split("/").slice(0, 4).join("/"));
      }
      return;
    }
    mount.revision++;
    mount.jobs.push(() => action(mount.handle, path.slice(mount.root.length + 1)));
    this.flush(mount).catch(() => {}); // flush reports the error and retains the failed operation for retry
  }

  flush(mount) {
    if (!mount.running && mount.jobs.length) {
      mount.running = (async () => {
        while (mount.jobs.length) { await mount.jobs[0](); mount.jobs.shift(); }
      })().catch(error => {
        this.report(`Could not save changes to ${mount.root}. ${error.message}`);
        throw error;
      }).finally(() => { mount.running = null; });
    }
    return mount.running || Promise.resolve();
  }

  get pending() { return Array.from(this.mounts.values()).some(m => m.jobs.length); }

  writable(path) {
    const virtual = ["/Documents", "/userData", "/imports", "/shared", "/downloads"].some(root => within(path, root));
    if (!virtual && !this.owner(path)) throw new Error(`'${path}' is outside a writable folder.`);
    if (!this.isDirectory(parent(path))) throw new Error(`Folder '${parent(path)}' does not exist.`);
  }

  put(path, entry) {
    this.writable(path);
    const previous = this.entries.get(path);
    if (previous && (previous.text === undefined) !== (entry.text === undefined)) throw new Error("File type mismatch.");
    this.entries.set(path, entry);
    this.enqueue(path, diskWrite(entry, !previous));
  }

  mkdir(path) {
    path = normal(path);
    if (!this.isDirectory(path)) this.put(path, directory());
  }

  write(path, text) { this.put(normal(path), { text, time: Date.now() }); }

  unlink(path) {
    path = normal(path);
    if (!this.entries.has(path)) return;
    this.writable(path);
    if (this.isDirectory(path) && this.list(path).length) throw new Error("Folder is not empty.");
    this.entries.delete(path);
    this.enqueue(path, eraseDisk);
  }

  rename(from, to) {
    from = normal(from); to = normal(to);
    if (from === to) return;
    this.writable(from); this.writable(to);
    if (this.owner(from) !== this.owner(to)) throw new Error("Cannot rename across mounted folders.");
    // Issie renames sheets. Queue the write before the removal so a failed copy keeps the original.
    this.write(to, this.read(from));
    this.unlink(from);
  }

  async mount(root, handle, scope = root, reuseUnchanged = false) {
    const previous = this.mounts.get(root);
    if (previous) await this.flush(previous);
    const revision = previous?.revision;
    const snapshot = new Map();
    const existing = this.entries;
    async function visit(path, dir) {
      snapshot.set(path, directory());
      for await (const [name, entry] of dir.entries()) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const target = child(path, name);
        if (entry.kind === "directory") await visit(target, entry);
        else if (projectFile.test(name)) {
          const file = await entry.getFile();
          const old = existing.get(target);
          snapshot.set(target, reuseUnchanged && old?.time === file.lastModified && old.size === file.size && old.text !== undefined
            ? old : { text: await file.text(), time: file.lastModified, size: file.size });
        }
      }
    }
    let dir = handle;
    for (const part of scope.slice(root.length).split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part);
    await visit(scope, dir);
    if (previous && previous.revision !== revision) return this.mount(root, handle, scope, reuseUnchanged);
    if (!this.entries.has(parent(root))) this.entries.set(parent(root), directory());
    for (const path of this.entries.keys()) if (within(path, scope)) this.entries.delete(path);
    for (const [path, entry] of snapshot) this.entries.set(path, entry);
    const mount = previous || { root, handle, jobs: [], revision: 0 };
    mount.scannedAt = Date.now(); mount.scanError = null; this.mounts.set(root, mount);
    return root;
  }

  async resolve(handle) {
    for (const mount of this.mounts.values()) {
      if (mount.root.startsWith("/shared/")) continue; // a saved link still has a temporary editor path
      const parts = await mount.handle.resolve(handle);
      if (parts) return [mount.root, ...parts].join("/");
    }
    return null;
  }

  async attach(handle) {
    const known = await this.resolve(handle);
    if (known) {
      // Refresh the mounted tree when the user explicitly picks its folder again.
      const mount = this.owner(known);
      await this.mount(mount.root, mount.handle);
      return known;
    }
    const group = child("/local", crypto.randomUUID());
    this.entries.set(group, directory());
    return this.mount(child(group, handle.name), handle);
  }

  async exportCopy(root, handle) {
    if (!(await handle.keys().next()).done) throw new Error("Choose an empty folder to save this working copy.");
    const mount = { root, handle, jobs: [], revision: 0 };
    this.mounts.set(root, mount);
    for (const [path, entry] of Array.from(this.entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (path !== root && within(path, root)) {
        const write = diskWrite(entry, true);
        mount.jobs.push(() => write(handle, path.slice(root.length + 1)));
      }
    }
    await this.flush(mount);
    this.unexported.delete(root);
  }
}
