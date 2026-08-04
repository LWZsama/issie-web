export async function connectAndRead() {
  throw new Error("USB debugging is unavailable in the browser build.");
}

export async function continuedOp() {}

export async function disconnect() {}

export async function pauseOp() {}

export async function readAllViewers() {
  return [];
}

export async function simpleConnect() {
  throw new Error("USB debugging is unavailable in the browser build.");
}

export async function step() {}

export async function stepAndReadAllViewers() {
  return [];
}
