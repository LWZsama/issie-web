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

function splitPath(inputPath) {
  return normalizePath(inputPath).split("/").filter(Boolean);
}

module.exports = {
  basename(inputPath) {
    const parts = splitPath(inputPath);
    return parts.length === 0 ? "" : parts[parts.length - 1];
  },
  dirname(inputPath) {
    const normalized = normalizePath(inputPath);
    const index = normalized.lastIndexOf("/");
    return index <= 0 ? "/" : normalized.slice(0, index);
  },
  extname(inputPath) {
    const name = module.exports.basename(inputPath);
    const index = name.lastIndexOf(".");
    return index <= 0 ? "" : name.slice(index);
  },
  join(...parts) {
    return normalizePath(parts.join("/"));
  },
};
