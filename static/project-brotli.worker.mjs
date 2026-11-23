import init, { compress, DecompressStream, BrotliStreamResultCode } from "./brotli/brotli_wasm.js";

async function expand(bytes, limit) {
  const decoder = new DecompressStream();
  const chunks = [];
  const block = 64 * 1024;
  let offset = 0;
  let size = 0;
  try {
    for (;;) {
      const result = decoder.decompress(bytes.subarray(offset, offset + block), Math.min(block, limit - size + 1));
      const { code, input_offset, buf } = result;
      result.free();
      offset += input_offset;
      size += buf.length;
      if (size > limit) throw new Error("Decoded project exceeds the 32 MiB link format limit.");
      chunks.push(buf);
      if (code === BrotliStreamResultCode.ResultSuccess && offset === bytes.length) {
        return new Uint8Array(await new Blob(chunks).arrayBuffer());
      }
      if (code === BrotliStreamResultCode.NeedsMoreOutput) continue;
      if (code === BrotliStreamResultCode.NeedsMoreInput && offset < bytes.length && input_offset > 0) continue;
      throw new Error("Invalid or incomplete Brotli project.");
    }
  } finally {
    decoder.free();
  }
}

self.onmessage = async ({ data: { operation, bytes, limit } }) => {
  try {
    await init();
    const output = operation === "compress" ? compress(bytes, { quality: 11 }) : await expand(bytes, limit);
    self.postMessage({ bytes: output }, [output.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
