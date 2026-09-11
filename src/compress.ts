/**
 * DEFLATE via the WHATWG Compression Streams API, which is available in
 * browsers and in Node >= 18 (with `deflate-raw` support from Node 21.2 / 22).
 * This keeps the library dependency-free at the cost of an async API.
 */

function hasCompressionStreams(): boolean {
  return (
    typeof globalThis.CompressionStream === "function" &&
    typeof globalThis.DecompressionStream === "function"
  );
}

function singleChunkStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function transcode(
  data: Uint8Array,
  format: "deflate" | "deflate-raw",
  mode: "compress" | "decompress",
): Promise<Uint8Array> {
  if (!hasCompressionStreams()) {
    throw new Error(
      "CompressionStream/DecompressionStream are unavailable in this runtime; " +
        "use Node >= 22 or a modern browser",
    );
  }
  const transform =
    mode === "compress" ? new CompressionStream(format) : new DecompressionStream(format);
  // The DOM types for Compression/DecompressionStream use `BufferSource`, which
  // does not line up with `ReadableWritablePair<Uint8Array, Uint8Array>`.
  const pair = transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  return await drain(singleChunkStream(data).pipeThrough(pair));
}

/** Raw DEFLATE (no zlib/gzip wrapper), matching Python `zlib.compress(..., wbits=-15)`. */
export function rawDeflate(data: Uint8Array): Promise<Uint8Array> {
  return transcode(data, "deflate-raw", "compress");
}

/** Inverse of {@link rawDeflate}. */
export function rawInflate(data: Uint8Array): Promise<Uint8Array> {
  return transcode(data, "deflate-raw", "decompress");
}

/** zlib-wrapped DEFLATE, matching Python `zlib.compress(data)` (used by v3.5). */
export function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  return transcode(data, "deflate", "compress");
}

/** Inverse of {@link zlibDeflate}. */
export function zlibInflate(data: Uint8Array): Promise<Uint8Array> {
  return transcode(data, "deflate", "decompress");
}
