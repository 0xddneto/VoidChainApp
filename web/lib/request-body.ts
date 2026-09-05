export class BodyError extends Error {
  constructor(message: string, readonly status: 400 | 413) { super(message); }
}
/** Enforces the real streamed byte count, including chunked requests. */
export async function readJsonObject(request: Request, maximum: number): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new BodyError('Request is too large.', 413);
  if (!request.body) throw new BodyError('Missing request body.', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new BodyError('Request is too large.', 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new BodyError('Malformed request body.', 400); }
}
