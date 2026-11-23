// The public module shared by the Web renderer, the CLI and other static sites.
// Sheet text passes through untouched. Issie resolves RAM files and sheet dependencies on open.
const defaultSite = "https://lwzsama.github.io/issie-web/";
const maxPayloadChars = 2 * 1024 * 1024;
const maxProjectBytes = 32 * 1024 * 1024;
const codecs = new Map([["gz", "gzip"], ["br", "brotli"]]);

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

function compressionStream(codec, Stream) {
  if (!codecs.has(codec)) throw new Error("Unknown project link compression.");
  try {
    return new Stream(codecs.get(codec));
  } catch {
    throw new Error(`This environment does not support ${codecs.get(codec)} project links.`);
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
 * The default codec is gzip ("gz"). Optional Brotli ("br") requires support at both ends.
 */
export async function createProjectUrl(project, site = defaultSite, codec = "gz") {
  validateProject(project);
  const bytes = new TextEncoder().encode(JSON.stringify({ name: project.name, files: project.files }));
  if (bytes.length > maxProjectBytes) throw new Error("Project exceeds the 32 MiB link format limit.");
  const stream = new Blob([bytes]).stream().pipeThrough(compressionStream(codec, globalThis.CompressionStream));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  if (Math.ceil(compressed.length * 4 / 3) > maxPayloadChars) throw new Error("Project is too large for a URL.");
  const url = new URL(site);
  url.hash = `project=v1.${codec}.${base64url(compressed)}`;
  return url.href;
}

/** Decode location.hash. Unrelated fragments leave the normal startup screen alone. */
export async function decodeProjectFragment(hash) {
  if (!hash.startsWith("#project=")) return null;
  if (hash.length > maxPayloadChars + 15) throw new Error("Project link is too large.");
  const match = /^#project=v1\.([a-z]+)\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) throw new Error("Invalid or unsupported project link format.");
  const [, codec, payload] = match;
  const inflate = compressionStream(codec, globalThis.DecompressionStream);
  const bytes = Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
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
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await new Blob(chunks).arrayBuffer());
  const project = JSON.parse(text);
  validateProject(project);
  return project;
}
