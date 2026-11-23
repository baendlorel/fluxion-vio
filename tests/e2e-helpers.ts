import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（tests/ 的上一级）。 */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 这些用例针对构建产物（dist/）运行，而不是 src/。
 *
 * 原因：动态文件经 esbuild 编译为 CJS 后会 `require` 本包，而宿主进程用的是 ESM 构建。
 * 只有在 dist 之上跑，才能覆盖真实的 ESM/CJS 双实例布局——vitest 的 `@` 源码别名会掩盖它。
 */
const DIST = join(PACKAGE_ROOT, 'dist');

export const ensureDist = (): void => {
  if (existsSync(join(DIST, 'index.mjs')) && existsSync(join(DIST, 'index.cjs'))) {
    return;
  }
  execFileSync('npx', ['tsx', './scripts/index.ts', '--build'], { cwd: PACKAGE_ROOT, stdio: 'ignore' });
};

/** 创建一个临时目录，用来放动态文件。 */
export const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'fluxion-vio-e2e-'));

/** 按 `{ 相对路径: 内容 }` 写入文件，父目录自动创建。 */
export const writeFiles = (root: string, files: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
};

/**
 * 在临时目录内伪造 node_modules/fluxion-vio，转发到本包的构建产物。
 *
 * esbuild 把动态文件编译成 CJS，所以它总是 require 到 index.cjs；exports 里仍给出 import 条件，
 * 保持与真实包一致的解析布局。
 */
export const installPackageShim = (dir: string): void => {
  writeFiles(dir, {
    'node_modules/fluxion-vio/package.json': JSON.stringify({
      name: 'fluxion-vio',
      version: '0.0.0-test',
      main: 'index.cjs',
      exports: { import: './index.mjs', require: './index.cjs' },
    }),
    'node_modules/fluxion-vio/index.cjs': `module.exports = require(${JSON.stringify(join(DIST, 'index.cjs'))});\n`,
    'node_modules/fluxion-vio/index.mjs': `export * from ${JSON.stringify(join(DIST, 'index.mjs'))};\n`,
  });
};

/** 向系统要一个空闲端口。 */
export const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/**
 * 在独立子进程里启动 dist 构建的服务器（ESM 入口，与真实部署一致），
 * 返回 URL 与该进程控制句柄。
 */
export const startServer = async (
  files: Record<string, string>,
  options: Record<string, unknown> = {},
): Promise<{
  dir: string;
  port: number;
  url: (path: string) => string;
  stop: () => Promise<void>;
  output: () => string;
}> => {
  ensureDist();
  const dir = makeTempDir();
  installPackageShim(dir);
  writeFiles(dir, files);

  const port = await getFreePort();
  const script = join(makeTempDir(), 'server.mjs');
  writeFiles(dirname(script), {
    'server.mjs': [
      `import { fluxion } from ${JSON.stringify(join(DIST, 'index.mjs'))};`,
      `const app = await fluxion(${JSON.stringify({ dir, host: '127.0.0.1', port, ...options })});`,
      `process.on('message', (m) => { if (m === 'stop') { app.stop(); process.exit(0); } });`,
      '',
    ].join('\n'),
  });

  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (stdout += c.toString()));

  // 等待端口可连
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${stdout}`);
    if (Date.now() > deadline) throw new Error(`server did not start:\n${stdout}`);
    try {
      await fetch(`http://127.0.0.1:${port}/__ready__`);
    } catch {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    break;
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.send('stop');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return { dir, port, url: (path: string) => `http://127.0.0.1:${port}${path}`, stop, output: () => stdout };
};
