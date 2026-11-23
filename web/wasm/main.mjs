import { dotnet } from "./dotnet.js";

try {
  const { getAssemblyExports, getConfig, setModuleImports } = await dotnet.create();
  setModuleImports("issie.worker", {
    send(connection, bytes) {
      const response = new Uint8Array(bytes);
      self.postMessage({ connection, frame: response.buffer }, [response.buffer]);
    },
  });
  const exports = await getAssemblyExports(getConfig().mainAssemblyName);
  const handle = exports.Issie.Sidecar.Wasm.WasmInterop.Handle;
  let pending = Promise.resolve();
  self.onmessage = ({ data: { connection, frame } }) => {
    pending = pending.then(() => handle(connection, new Uint8Array(frame)))
      .catch(error => self.postMessage({ issieWasmError: String(error) }));
  };
  self.postMessage({ issieWasmReady: true });
} catch (error) { self.postMessage({ issieWasmError: String(error) }); }
