function splitRawPath(inputPath) {
  return `${inputPath || ""}`.replace(/\\/g, "/");
}

function normalizePath(inputPath) {
  const raw = splitRawPath(inputPath);
  const isAbsolute = raw.startsWith("/");
  const parts = raw.split("/").filter((part) => part && part !== ".");
  const stack = [];

  for (const part of parts) {
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push("..");
      }
    } else {
      stack.push(part);
    }
  }

  if (isAbsolute) {
    return stack.length === 0 ? "/" : `/${stack.join("/")}`;
  }

  return stack.join("/");
}

function splitPath(inputPath) {
  const normalized = normalizePath(inputPath);
  return normalized.split("/").filter(Boolean);
}

module.exports = {
  basename(inputPath) {
    const parts = splitPath(inputPath);
    return parts.length === 0 ? "" : parts[parts.length - 1];
  },
  dirname(inputPath) {
    const normalized = normalizePath(inputPath);
    if (!normalized || normalized === ".") {
      return ".";
    }

    const index = normalized.lastIndexOf("/");

    if (index < 0) {
      return ".";
    }

    if (index === 0) {
      return "/";
    }

    return normalized.slice(0, index);
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
