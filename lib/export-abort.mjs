export class ExportCancellationError extends Error {
  constructor(message = "Export cancelled") {
    super(message);
    this.name = "ExportCancellationError";
    this.code = "EXPORT_CANCELLED";
  }
}

export function throwIfAborted(signal, phase = "export") {
  if (signal?.aborted) throw new ExportCancellationError(`Export cancelled during ${phase}`);
}

export function createAbortCheckpoint(signal, phase, yieldEvery = 64) {
  const interval = Number.isSafeInteger(yieldEvery) && yieldEvery > 0 ? yieldEvery : 64;
  let calls = 0;
  return async function checkpoint() {
    throwIfAborted(signal, phase);
    calls += 1;
    if (calls % interval !== 0) return;
    await new Promise((resolve) => setImmediate(resolve));
    throwIfAborted(signal, phase);
  };
}
