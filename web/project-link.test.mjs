import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import test from "node:test";
import { createProjectUrl, decodeProjectFragment } from "../static/project-link.mjs";

const project = {
  name: "EEP1 示例",
  files: { "cpu.dprj": "", "main.dgm": "{}", "code.ram": "0x00 0x1101\n0x20 0xc0fb", "rtl/é.v": "\uFEFF// λ\r\n" },
};

test("a producer can share nested files and sparse RAM without changing their text", async () => {
  const site = "https://example.test/issie/?lang=en#old";
  const url = new URL(await createProjectUrl(project, site));
  assert.equal(url.search, "?lang=en");
  const quality11 = brotliCompressSync(JSON.stringify(project), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  assert.equal(url.hash, "#project=" + quality11.toString("base64url"));
  assert.deepEqual(await decodeProjectFragment(url.hash), project);
});

test("existing tagged gzip and Brotli project links still open", async () => {
  const bytes = JSON.stringify(project);
  for (const [codec, compressed] of [["gz", gzipSync(bytes)], ["br", brotliCompressSync(bytes)]]) {
    assert.deepEqual(await decodeProjectFragment(`#project=v1.${codec}.${compressed.toString("base64url")}`), project);
  }
});

test("the CLI packs every sheet of the upstream CPU and its actual ROM source", async () => {
  const dir = new URL("../static/demos/3cpu/", import.meta.url);
  const cli = fileURLToPath(new URL("../scripts/pack-project.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [cli, fileURLToPath(dir), "--base-url", "https://example.test/"], {
    encoding: "utf8",
  });
  const packed = await decodeProjectFragment(new URL(output.trim()).hash);
  assert.equal(packed.name, "3cpu");
  const sourceFiles = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && /\.dgm$/i.test(entry.name));
  assert.deepEqual(Object.keys(packed.files).filter(p => /\.dgm$/i.test(p)).sort(), sourceFiles.map(entry => entry.name).sort());
  for (const [name, text] of Object.entries(packed.files)) {
    assert.equal(text, await readFile(new URL(name, dir), "utf8"));
  }
  assert.ok(packed.files["testloop.ram"]);
});

test("unrelated fragments leave startup alone and invalid project links reject", async () => {
  for (const hash of ["", "#demo=3&code=1234", "#code=1234", "#other"]) {
    assert.equal(await decodeProjectFragment(hash), null);
  }
  for (const hash of ["#project=", "#project=v2.gz.AAAA", "#project=v1.zip.AAAA", "#project=v1.gz.AAAA", "#project=AAA+", "#project=A"]) {
    await assert.rejects(decodeProjectFragment(hash));
  }
  const valid = new URL(await createProjectUrl(project)).hash;
  await assert.rejects(decodeProjectFragment(valid.slice(0, -8)));
});

test("the decoder checks paths, conflicting entries and expanded size before mounting", async () => {
  function wire(value) {
    return "#project=" + brotliCompressSync(JSON.stringify(value), { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }).toString("base64url");
  }
  for (const bad of ["../bad.ram", "/other/main.dgm", "path\\file", "C:/data", "./main", "a//b", "a\0b"]) {
    const unsafe = { name: "CPU", files: { "main.dgm": "{}", [bad]: "" } };
    await assert.rejects(createProjectUrl(unsafe));
    await assert.rejects(decodeProjectFragment(wire(unsafe)));
  }
  await assert.rejects(decodeProjectFragment(wire({ name: "..", files: project.files })));
  await assert.rejects(decodeProjectFragment(wire({ name: "x", files: { note: "only text" } })));
  await assert.rejects(decodeProjectFragment(wire({ name: "x", files: { "main.dgm": "", dir: "", "dir/a": "" } })));
  const oversized = { name: "x", files: { "main.dgm": " ".repeat(32 * 1024 * 1024) } };
  await assert.rejects(decodeProjectFragment(wire(oversized)), /32 MiB/);
});
