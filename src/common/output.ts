import { writeSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 把写入 process.stdout / process.stderr 的内容（含 console.*）追加到 filePath。
 *
 * 写入是同步的：没有缓冲，process.exit 前无需 flush。
 */
export async function redirectOutput(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // 让下面的闭包持有 handle；否则 FileHandle 被回收会把 fd 一起关掉。
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
