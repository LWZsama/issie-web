// Supply the desktop client's WebSocket constructor through webpack. Other connections
// still use the browser's own constructor. The worker lasts as long as the desktop sidecar would.
let worker, ready, active;
let generation = 0;

function runtime() {
  if (worker) return ready;
  worker = new Worker(new URL("wasm/main.mjs", document.baseURI), { type: "module", name: "issie-simulation" });
  ready = new Promise((resolve, reject) => {
    function failed(message) {
      worker.terminate();
      worker = null;
      reject(new Error(message));
      const socket = active;
      if (socket) { socket.onerror?.({ message }); socket.close(); }
    }
    worker.onerror = event => failed(event.message || "Simulation worker failed.");
    worker.onmessageerror = () => failed("Invalid simulation worker message.");
    worker.onmessage = ({ data }) => {
      if (data.issieWasmReady) resolve();
      else if (data.issieWasmError) failed(data.issieWasmError);
      else if (active && data.connection === active.connection) active.onmessage?.({ data: data.frame });
    };
  });
  return ready;
}

export class HostSocket {
  constructor(url, protocols) {
    if (url !== "ws://127.0.0.1:0/?token=issie-web") return new globalThis.WebSocket(url, protocols);
    active?.close();
    active = this;
    this.connection = ++generation;
    this.readyState = 0;
    runtime().then(() => {
      if (active !== this) return;
      this.readyState = 1;
      this.onopen?.({});
    }, () => {});
  }
  send(bytes) {
    if (this.readyState !== 1) throw new Error("The simulation worker is not connected.");
    const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
    const frame = view.slice().buffer;
    worker.postMessage({ connection: this.connection, frame }, [frame]);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (active === this) active = null;
    this.onclose?.({});
  }
}
