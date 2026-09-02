function toBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

try {
  const { dotnet } = await import("./dotnet.js");
  const { getAssemblyExports, getConfig } = await dotnet
    .withDiagnosticTracing(false)
    // The published manifest carries integrity hashes, so let the browser reuse valid runtime
    // assets between page loads. The default no-cache fetch otherwise turns every cold page load
    // into another full .NET WASM download.
    .withConfig({ disableNoCacheFetch: true })
    .create();
  const config = getConfig();
  const exports = await getAssemblyExports(config.mainAssemblyName);
  const handle =
    exports?.Issie?.Sidecar?.Wasm?.WasmInterop?.Handle
    ?? exports?.WasmInterop?.Handle;
  if (typeof handle !== "function") {
    throw new Error(`WASM export Handle was not found in ${config.mainAssemblyName}: ${JSON.stringify(Object.keys(exports))}`);
  }

  self.onmessage = (event) => {
    try {
      const response = fromBase64(handle(toBase64(event.data)));
      self.postMessage(response.buffer, [response.buffer]);
    } catch (error) {
      self.postMessage({ issieWasmError: error?.message || String(error) });
    }
  };

  self.postMessage({ issieWasmReady: true });
} catch (error) {
  const message = JSON.stringify({
    name: error?.name,
    message: error?.message,
    stack: error?.stack,
    text: String(error),
  });
  console.error("Issie .NET WASM worker failed to start", error);
  self.postMessage({ issieWasmError: message });
}
