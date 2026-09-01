// Browser transport for the upstream .NET sidecar protocol.
//
// SidecarClient already speaks the complete binary protocol. In the Web build its WebSocket is a
// small adapter over a .NET WASM runtime hosted in a dedicated Worker, so the renderer keeps the
// desktop client and the simulation core without putting simulation work on the UI thread.

const workerUrl = () => new URL("wasm/main.mjs", document.baseURI);
let currentDesignFrames = [];
let latestDesignFrames = [];
const sockets = new Set();
let runtime = null;
let activeSocket = null;

function frameBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("WASM sidecar expects a binary frame");
}

function rememberDesignFrame(frame) {
  if (frame.length < 16) return;

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const index = view.getUint32(8, true);
  const count = view.getUint32(12, true);

  if (index === 0) currentDesignFrames = [];
  currentDesignFrames.push(new Uint8Array(frame));

  if (count > 0 && currentDesignFrames.length === count) {
    latestDesignFrames = currentDesignFrames;
    currentDesignFrames = [];
  }
}

function startRuntime() {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const worker = new Worker(workerUrl(), {
    type: "module",
    name: "issie-dotnet-simulation",
  });
  const state = {
    worker,
    ready,
    status: "starting",
    failed: false,
    fail(message) {
      if (state.failed) return;
      state.failed = true;
      state.status = "failed";
      worker.terminate();
      if (runtime === state) runtime = null;
      const error = message instanceof Error ? message : new Error(message);
      rejectReady(error);
      activeSocket?.fail(error.message);
    },
  };

  worker.onmessage = (event) => {
    const data = event.data;

    if (data && data.issieWasmReady) {
      state.status = "ready";
      resolveReady();
    } else if (data && data.issieWasmError) {
      state.fail(data.issieWasmError);
    } else if (activeSocket && activeSocket.readyState !== WasmSidecarSocket.CLOSED) {
      activeSocket.receive(data);
    }
  };
  worker.onerror = (event) => state.fail(event.message || "WASM sidecar worker failed");
  worker.onmessageerror = () => state.fail("WASM sidecar worker could not decode a message");

  ready.catch(() => {
    if (runtime === state) runtime = null;
  });
  return state;
}

function ensureRuntime() {
  if (runtime === null) runtime = startRuntime();
  return runtime;
}

class WasmSidecarSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = WasmSidecarSocket.CONNECTING;
    this.binaryType = "arraybuffer";
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.runtime = ensureRuntime();
    this.worker = this.runtime.worker;
    activeSocket = this;
    sockets.add(this);

    this.runtime.ready
      .then(() => this.open())
      .catch((error) => this.fail(error.message || String(error)));
  }

  open() {
    if (this.readyState !== WasmSidecarSocket.CONNECTING) return;
    this.readyState = WasmSidecarSocket.OPEN;
    queueMicrotask(() => this.onopen?.({ target: this }));
  }

  receive(data) {
    this.onmessage?.({ data, target: this });
  }

  send(value) {
    if (this.readyState !== WasmSidecarSocket.OPEN) {
      throw new Error("WASM sidecar socket is not open");
    }

    const bytes = frameBytes(value);
    const copy = new Uint8Array(bytes);
    if ((copy[0] & 0x3f) === 4) {
      rememberDesignFrame(copy);
    }

    this.worker.postMessage(copy.buffer, [copy.buffer]);
  }

  close() {
    if (this.readyState === WasmSidecarSocket.CLOSED) return;
    this.readyState = WasmSidecarSocket.CLOSING;
    if (activeSocket === this) activeSocket = null;
    this.readyState = WasmSidecarSocket.CLOSED;
    sockets.delete(this);
    this.onclose?.({ target: this });
  }

  fail(message) {
    if (this.readyState === WasmSidecarSocket.CLOSED) return;
    this.onerror?.({ target: this, type: "error", message });
    this.close();
  }
}

const sidecarApi = {
  backend: "dotnet-wasm",
  runtime: "dotnet-wasm-worker",
  workerUrl,
  prewarm: () => ensureRuntime().ready,
  workerState: () => runtime?.status || "idle",
  createSocket: () => new WasmSidecarSocket("wasm://issie-sidecar"),
  designFrames: () => latestDesignFrames.map((frame) => new Uint8Array(frame)),
  openSockets: () => sockets.size,
};

if (typeof window !== "undefined") {
  window.__issieWasmSidecar = sidecarApi;
  window.issieBridge.sidecar = {
    port: () => ({ port: 0, token: "wasm" }),
  };
  window.WebSocket = WasmSidecarSocket;

  // Match the desktop app: initialise the simulator while the UI is starting, not on the first
  // click. The worker keeps all .NET work off the renderer thread, and a failed warm-up is retried
  // by the first real connection through ensureRuntime().
  sidecarApi.prewarm().catch(() => {});
}

module.exports = sidecarApi;
