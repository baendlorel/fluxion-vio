import { buildSync } from 'esbuild';
import { compileFunction } from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NormalizedFluxionOptions } from '@/types.js';

/** 由加载器加载的一个模块。`deps` 记录它 require 过的实例，缓存被重新填充时也能发现过期的依赖。 */
export interface LoadedModule {
  id: string;
  filename: string;
  exports: any;
  mtimeMs: number;
  size: number;
  deps: Map<string, LoadedModule>;
}

/** 所有已加载模块，以绝对路径为键。显式传入而非放在模块级，缓存由创建它的 fluxion 实例持有。 */
export type ModuleCache = Map<string, LoadedModule>;

export type LoaderOptions = Pick<NormalizedFluxionOptions, 'dir' | 'target'>;

const NODE_MODULES = `${sep}node_modules${sep}`;

const COMPILED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const EXTENSIONS = [...COMPILED, '.json'];
// 按 TypeScript 约定，import './a.js' 实际指向 a.ts
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const isBare = (specifier: string) => !specifier.startsWith('.') && !isAbsolute(specifier);

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isChanged = (m: LoadedModule) => {
  try {
    const s = statSync(m.filename);
    return s.mtimeMs !== m.mtimeMs || s.size !== m.size;
  } catch {
    // 文件消失也视为已变更
    return true;
  }
};

/** 按 esbuild 的规则，找出无扩展名或 .js 风格路径对应的真实文件。 */
const findFile = (base: string): string | undefined => {
  if (isFile(base)) {
    return base;
  }

  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (const e of JS_TO_TS[ext] ?? []) {
    if (isFile(stem + e)) {
      return stem + e;
    }
  }
  for (const e of EXTENSIONS) {
    if (isFile(base + e)) {
      return base + e;
    }
  }
  for (const e of EXTENSIONS) {
    if (isFile(join(base, 'index' + e))) {
      return join(base, 'index' + e);
    }
  }
};

const isHot = (file: string, dir: string) => {
  const ext = extname(file);
  return file.startsWith(dir) && !file.includes(NODE_MODULES) && (COMPILED.has(ext) || ext === '.json');
};

/**
 * `shadowed` 为 true 时，改用 define 常量而不是函数参数提供 __dirname / __filename，
 * 供那些在顶层自己声明了同名变量的源码使用。之所以只在需要时切换：define 出来的名字不是绑定，
 * eval 会看不见它，赋值还会泄漏到全局对象。
 */
const compile = (file: string, target: LoaderOptions['target'], shadowed: boolean): string => {
  const define: Record<string, string> = {
    'import.meta.url': JSON.stringify(pathToFileURL(file).href),
    'import.meta.filename': JSON.stringify(file),
    'import.meta.dirname': JSON.stringify(dirname(file)),
  };
  if (shadowed) {
    define.__dirname = JSON.stringify(dirname(file));
    define.__filename = JSON.stringify(file);
  }

  const { outputFiles } = buildSync({
    entryPoints: [file],
    bundle: false,
    write: false,
    platform: 'node',
    format: 'cjs',
    target,
    sourcemap: 'inline',
    sourcesContent: false,
    logLevel: 'silent',
    // import(x) 会变成 require(x)：vm 里的函数无法执行原生动态 import
    supported: { 'dynamic-import': false },
    define,
  });
  return outputFiles[0].text;
};

/**
 * 优先用函数参数提供 __dirname，这样 eval 看得见、赋值也只影响局部。
 * 若源码自己声明了 __dirname 导致编译失败，则改用 define 重新编译。
 * 编译不执行代码，所以失败重试没有副作用。
 */
const buildFunction = (file: string, target: LoaderOptions['target']) => {
  const params = ['exports', 'require', 'module', '__filename', '__dirname'];
  try {
    return compileFunction(compile(file, target, false), params, { filename: file });
  } catch (e) {
    const redeclared = e instanceof SyntaxError && /__dirname|__filename/.test(e.message);
    if (!redeclared) {
      throw e;
    }
    return compileFunction(compile(file, target, true), params.slice(0, 3), { filename: file });
  }
};

/** 一个带 Node 原生 require 那些属性的 require 函数。 */
interface ModuleRequire {
  (specifier: string): any;
  resolve(specifier: string): string;
  cache: NodeJS.Dict<NodeModule>;
}

/** 每个模块仅剩的闭包，每次全新加载时创建一次：它需要记住是哪个模块在 require。 */
const createModuleRequire = (
  from: LoadedModule,
  cache: ModuleCache,
  options: LoaderOptions,
): ModuleRequire => {
  const native = createRequire(from.filename);
  const locate = (specifier: string) =>
    isBare(specifier) ? undefined : findFile(resolve(dirname(from.filename), specifier));

  return Object.assign(
    (specifier: string) => {
      const file = locate(specifier);
      if (file === undefined) {
        // 内置模块、npm 包以及找不到的路径，都交给原生 require（由它报错）
        return native(specifier);
      }
      if (!isHot(file, options.dir)) {
        return native(file);
      }
      const dep = loadFile(file, cache, options);
      // 加载很久之后才发生的 require（如函数内的 import()）也要记录下来
      from.deps.set(file, dep);
      return dep.exports;
    },
    {
      resolve: (specifier: string) => locate(specifier) ?? native.resolve(specifier),
      cache: native.cache,
    },
  );
};

const evaluate = (file: string, mod: LoadedModule, cache: ModuleCache, options: LoaderOptions): void => {
  const ext = extname(file);
  if (ext === '.json') {
    mod.exports = JSON.parse(readFileSync(file, 'utf8'));
    return;
  }
  if (!COMPILED.has(ext)) {
    throw new Error(`FluxionLoader: unsupported file type "${ext}" (${file})`);
  }

  const fn = buildFunction(file, options.target);
  fn.call(mod.exports, mod.exports, createModuleRequire(mod, cache, options), mod, file, dirname(file));
};

const loadFresh = (file: string, cache: ModuleCache, options: LoaderOptions): LoadedModule => {
  // 先读时间戳再读文件：期间发生的编辑下次会被判定为变更，而不是被漏掉
  const { mtimeMs, size } = statSync(file);
  const mod: LoadedModule = { id: file, filename: file, exports: {}, mtimeMs, size, deps: new Map() };
  // 先注册再执行，循环 import 时能看到未完成的 exports 而不是死循环
  cache.set(file, mod);
  try {
    evaluate(file, mod, cache, options);
  } catch (e) {
    cache.delete(file);
    throw e;
  }
  return mod;
};

const collectChain = (root: LoadedModule): Set<LoadedModule> => {
  const chain = new Set([root]);
  // Set 在迭代中会访问新加入的元素，其内置去重也天然阻止了环
  for (const m of chain) {
    for (const dep of m.deps.values()) {
      chain.add(dep);
    }
  }
  return chain;
};

const anyStale = (cache: ModuleCache, chain: Set<LoadedModule>): boolean => {
  for (const m of chain) {
    if (cache.get(m.filename) !== m || isChanged(m)) {
      return true;
    }
  }
  return false;
};

/** 依赖链上没有任何变化就返回缓存，否则整条链丢弃并重新加载。 */
const loadFile = (file: string, cache: ModuleCache, options: LoaderOptions): LoadedModule => {
  const cached = cache.get(file);
  if (cached === undefined) {
    return loadFresh(file, cache, options);
  }

  const chain = collectChain(cached);
  if (!anyStale(cache, chain)) {
    return cached;
  }
  for (const m of chain) {
    // 同一路径可能已被别人换成更新的实例，那一个正是想要的，保留
    if (cache.get(m.filename) === m) {
      cache.delete(m.filename);
    }
  }
  return loadFresh(file, cache, options);
};

/**
 * 加载 `options.dir` 下的 ts/js 文件。它 import 的本地文件同样处理，各自经 esbuild 编译；
 * node_modules、内置模块和 `dir` 之外的文件走原生 require。
 *
 * 首次加载时记录该文件及它 require 的所有文件的 mtime 与 size。再次请求时比对：
 * 任一不同就丢弃整条链重新加载，否则直接返回缓存的 exports。从不比较文件内容。
 *
 * 同步实现，因为 require 本身是同步的。require() 返回 exports，所以 `export default x` 对应 result.default。
 */
export const requireModule = (cache: ModuleCache, options: LoaderOptions, absolutePath: string): any =>
  loadFile(resolve(absolutePath), cache, options).exports;
