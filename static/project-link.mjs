// The public module shared by the Web renderer, the CLI and other static sites.
// Sheet text passes through untouched. Issie resolves RAM files and sheet dependencies on open.
const defaultSite = "https://lwzsama.github.io/issie-web/";
const maxPayloadChars = 2 * 1024 * 1024;
const maxProjectBytes = 32 * 1024 * 1024;

function validSegment(name) {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".."
    && !/[\\/:\u0000-\u001f]/u.test(name);
}

function validateProject(project) {
  if (!validSegment(project?.name)) throw new Error("Invalid project directory name.");
  const files = project.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Expected a map of project files.");
  }
  const paths = Object.keys(files);
  if (!paths.some(path => !path.includes("/") && path.toLowerCase().endsWith(".dgm"))) {
    throw new Error("The project needs a .dgm sheet in its root directory.");
  }
  for (const path of paths) {
    const parts = path.split("/");
    if (!parts.every(validSegment) || typeof files[path] !== "string") {
      throw new Error("Project files need relative paths and UTF-8 text contents.");
    }
    let parent = "";
    for (const part of parts.slice(0, -1)) {
      parent = parent ? parent + "/" + part : part;
      if (Object.hasOwn(files, parent)) throw new Error("A project file is also used as a directory.");
    }
  }
}

async function runBrotli(operation, bytes) {
  if (globalThis.process?.versions?.node) {
    const { brotliCompress, brotliDecompress, constants } = await import("node:zlib");
    const { promisify } = await import("node:util");
    if (operation === "compress") {
      return promisify(brotliCompress)(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    }
    try {
      return await promisify(brotliDecompress)(bytes, { maxOutputLength: maxProjectBytes });
    } catch (error) {
      if (error.code === "ERR_BUFFER_TOO_LARGE") throw new Error("Decoded project exceeds the 32 MiB link format limit.");
      throw error;
    }
  }
  const url = new URL("./project-brotli.worker.mjs", import.meta.url);
  // A site importing the public module can only start a Worker from its own origin.
  const bootstrap = url.origin !== location.origin
    ? URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)}`], { type: "text/javascript" }))
    : null;
  let worker;
  try {
    worker = new Worker(bootstrap || url, { type: "module" });
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.bytes);
      worker.onerror = event => reject(new Error(event.message || "Could not load the Brotli codec."));
      worker.postMessage({ operation, bytes, limit: maxProjectBytes }, [bytes.buffer]);
    });
  } finally {
    worker?.terminate();
    if (bootstrap) URL.revokeObjectURL(bootstrap);
  }
}

function base64url(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Import from <Issie Web site>/static/project-link.mjs or bundle this module with the producer.
 * Pass the UTF-8 text of all sheets and companion files, keyed by relative path.
 * Example: await createProjectUrl({ name: "CPU", files: { ...templateFiles, "program.ram": ramText } })
 */
export async function createProjectUrl(project, site = defaultSite) {
  validateProject(project);
  const bytes = new TextEncoder().encode(JSON.stringify({ name: project.name, files: project.files }));
  if (bytes.length > maxProjectBytes) throw new Error("Project exceeds the 32 MiB link format limit.");
  const compressed = await runBrotli("compress", bytes);
  if (Math.ceil(compressed.length * 4 / 3) > maxPayloadChars) throw new Error("Project is too large for a URL.");
  const url = new URL(site);
  url.hash = `project=${base64url(compressed)}`;
  return url.href;
}

async function decompress(bytes, format) {
  let inflate;
  try {
    inflate = new DecompressionStream(format);
  } catch (error) {
    if (format === "brotli") return runBrotli("decompress", bytes);
    throw error;
  }
  const reader = new Blob([bytes]).stream().pipeThrough(inflate).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxProjectBytes) {
      await reader.cancel();
      throw new Error("Decoded project exceeds the 32 MiB link format limit.");
    }
    chunks.push(value);
  }
  return new Blob(chunks).arrayBuffer();
}

/** Decode location.hash. Links shared before the switch carried an explicit codec. */
export async function decodeProjectFragment(hash) {
  if (!hash.startsWith("#project=")) return null;
  if (hash.length > maxPayloadChars + 15) throw new Error("Project link is too large.");
  const match = /^#project=(?:v1\.(gz|br)\.)?([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) throw new Error("Invalid or unsupported project link format.");
  const [, codec, payload] = match;
  if (payload.length > maxPayloadChars) throw new Error("Project link is too large.");
  const bytes = Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  const raw = await decompress(bytes, codec === "gz" ? "gzip" : "brotli");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const project = JSON.parse(text);
  validateProject(project);
  return project;
}
