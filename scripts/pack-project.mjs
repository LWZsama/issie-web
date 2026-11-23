import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createProjectUrl } from "../static/project-link.mjs";

const usage = "node scripts/pack-project.mjs [--base-url URL] PROJECT_DIRECTORY";
const extensions = new Set([".dgm", ".dprj", ".ram", ".ldgm", ".v", ".sv", ".vh", ".txt"]);

async function readProject(directory) {
  const files = Object.create(null);
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  async function visit(relative) {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = relative ? relative + "/" + entry.name : entry.name;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== "backup") await visit(path);
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        files[path] = utf8.decode(await readFile(join(directory, path)));
      }
    }
  }
  await visit("");
  return { name: basename(directory), files };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "base-url": { type: "string" }, brotli: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    console.log(usage + "\nPrint a self-contained Issie URL for the sheets, RAM, Verilog and text files in a directory."
      + "\nThe browser API is exported from <Issie Web site>/static/project-link.mjs.");
  } else {
    if (positionals.length !== 1) throw new Error(usage);
    const project = await readProject(resolve(positionals[0]));
    console.log(await createProjectUrl(project, values["base-url"]));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
