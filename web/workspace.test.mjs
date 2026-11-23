import test from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "./workspace.mjs";

// The same handle API is used by the browser's private directory and by user-granted folders.
function folder(name, initial = {}) {
  const entries = new Map();
  const dir = {
    name, kind: "directory", entries: async function* () { yield* entries; },
    keys: async function* () { yield* entries.keys(); },
    getDirectoryHandle: (n, options) => get(n, "directory", options),
    getFileHandle: (n, options) => get(n, "file", options),
    removeEntry: async n => { entries.delete(n); },
  };
  function file(n, text) {
    return { name: n, kind: "file", getFile: async () => ({ text: async () => text, lastModified: 123 }),
      createWritable: async () => ({ write: async value => { text = value; }, close: async () => {}, abort: async () => {} }) };
  }
  async function get(n, kind, options = {}) {
    if (!entries.has(n)) {
      if (!options.create) throw new DOMException("missing", "NotFoundError");
      entries.set(n, kind === "file" ? file(n, "") : folder(n));
    }
    if (entries.get(n).kind !== kind) throw new DOMException("wrong kind", "TypeMismatchError");
    return entries.get(n);
  }
  for (const [n, value] of Object.entries(initial)) entries.set(n, typeof value === "string" ? file(n, value) : folder(n, value));
  return dir;
}

test("the desktop browser can distinguish projects, markerless sheets and libraries", async () => {
  const ws = new Workspace(assert.fail);
  await ws.mount("/Documents", folder("root", { project: { "x.dprj": "", "a.dgm": "{}" },
    lost: { "b.dgm": "{}" }, library: { "ff.ldgm": "{}" } }));
  const rows = ws.browse("\\Documents").entries;
  assert.deepEqual(rows.map(r => [r.hasMarker, r.sheetCount, r.componentCount]), [[false, 0, 1], [false, 1, 0], [true, 1, 0]]);
  assert.equal(ws.entries.get("/Documents/lost/b.dgm").time, 123);
});

test("saving, renaming, backing up and deleting survive a new mount", async () => {
  const disk = folder("project", { "main.dgm": "old", "delete.dgm": "old" }), ws = new Workspace(assert.fail);
  const root = "/Documents";
  await ws.mount(root, disk);
  ws.write(root + "/main.dgm", "edited");
  ws.rename(root + "/main.dgm", root + "/renamed.dgm");
  ws.mkdir(root + "/backup"); ws.write(root + "/backup/main.dgm", "snapshot");
  ws.unlink(root + "/delete.dgm");
  await ws.flush(ws.owner(root));
  const reopened = new Workspace(assert.fail);
  await reopened.mount(root, disk);
  assert.deepEqual(reopened.list(root), ["backup", "renamed.dgm"]);
  assert.equal(reopened.read(root + "/renamed.dgm"), "edited");
  assert.equal(reopened.read(root + "/backup/main.dgm"), "snapshot");
});

test("a failed rename can retry the write before removing the source", async () => {
  const errors = [], disk = folder("project", { "old.dgm": "original" }), ws = new Workspace(e => errors.push(e));
  await ws.mount("/Documents", disk);
  const get = disk.getFileHandle;
  let first = true;
  disk.getFileHandle = async (name, options) => {
    const handle = await get(name, options), write = handle.createWritable;
    if (name === "new.dgm" && first) {
      first = false; handle.createWritable = () => { handle.createWritable = write; throw new Error("Permission lost"); };
    }
    return handle;
  };
  ws.rename("/Documents/old.dgm", "/Documents/new.dgm");
  await assert.rejects(ws.flush(ws.owner("/Documents")), /Permission lost/);
  assert.equal(await (await (await get("old.dgm")).getFile()).text(), "original");
  await ws.flush(ws.owner("/Documents"));
  assert.equal(await (await (await get("new.dgm")).getFile()).text(), "original");
  await assert.rejects(get("old.dgm"), { name: "NotFoundError" });
  assert.equal(errors.length, 1);
});

test("a folder created outside the app after mounting cannot be overwritten by New Project", async () => {
  const disk = folder("root"), ws = new Workspace(() => {});
  await ws.mount("/Documents", disk);
  const outside = await disk.getDirectoryHandle("Lab", { create: true });
  const existing = await outside.getFileHandle("main.dgm", { create: true });
  const writer = await existing.createWritable(); await writer.write("original"); await writer.close();
  ws.mkdir("/Documents/Lab"); ws.write("/Documents/Lab/main.dgm", "new");
  await assert.rejects(ws.flush(ws.owner("/Documents")), /already exists/);
  assert.equal(await (await existing.getFile()).text(), "original");
});

test("a shared link is isolated until saved, and an occupied destination is refused", async () => {
  const ws = new Workspace(assert.fail);
  const root = ws.workingCopy({ name: "CPU", files: { "main.dgm": "diagram", "rtl/code.ram": "0x20 0xc0fb" } });
  assert.equal(ws.read(root + "/CPU.dprj"), "");
  await assert.rejects(ws.exportCopy(root, folder("busy", { "main.dgm": "existing" })), /empty folder/);
  const dest = folder("empty");
  await ws.exportCopy(root, dest);
  ws.write(root + "/main.dgm", "edited"); await ws.flush(ws.owner(root));
  const reopened = new Workspace(assert.fail);
  await reopened.mount("/Documents", dest);
  assert.equal(reopened.read("/Documents/main.dgm"), "edited");
  assert.equal(reopened.read("/Documents/rtl/code.ram"), "0x20 0xc0fb");
});
