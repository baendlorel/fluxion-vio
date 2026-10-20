// TODO 这一版loader有着极为严格的要求，ts文件格式必须是：
// import xxx from 'xxx' 不可以引入type
// some logic ...
// export default defineFluxionModule(...)
import { readFile } from 'node:fs/promises';

export async function fluxionRequire(absolutePath: string) {
  const raw = await readFile(absolutePath, { encoding: 'utf-8' });
  const functionBody = raw
    .replaceAll(/\*\s+as/, '')
    .split('\n')
    .map((t) => t.trim())
    .map((t) => {
      if (/import\s+type/.test(t)) {
        return '';
      }

      if (t.startsWith('import')) {
        t = t.replace('import', 'const ').replace('from', '=await fluxionRequire(').replace(';', '') + ')';
        // TODO 将引入的模块路径转换为absolute路径才行
        return t;
      }

      if (/^export\s+default/.test(t)) {
        return t.replace(/^export\s+default/, 'return ');
      }

      return t;
    })
    .join('\n');

  return new Function(`return (async () => { ${functionBody} })()`)();
}

globalThis.fluxionRequire = fluxionRequire;

declare global {
  var fluxionRequire: (absolutePath: string) => Promise<any>;
}
