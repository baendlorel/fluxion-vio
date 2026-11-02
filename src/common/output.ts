import { writeSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Send everything written to `process.stdout` / `process.stderr` (so `console.*` too) to `filePath`, appending.
 *
 * Writes are synchronous: nothing is buffered, so there is nothing to flush before `process.exit` or `process.execve`.
 */
export async function redirectOutput(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // The handle stays referenced by the closure below; a collected FileHandle would close the fd under us.
  const handle = await open(filePath, 'a');

  const write = (chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => {
    writeSync(handle.fd, Buffer.from(chunk));
    const done = typeof encoding === 'function' ? encoding : cb;
    if (typeof done === 'function') {
      done();
    }
    return true;
  };

  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
}
