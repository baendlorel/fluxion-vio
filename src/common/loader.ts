import { buildSync } from 'esbuild';
import { compileFunction } from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FluxionModule {
  id: string;
  filename: string;
  exports: any;
  /**
   * mtime and size of the file when it was loaded. A file counts as changed when either differs.
   */
  mtimeMs: number;
  size: number;
  /**
   * The modules under `dir` this one has required, by absolute path. The instances are kept (not just the paths),
   * so the module knows when what it holds is no longer what the cache holds.
   */
  deps: Map<string, FluxionModule>;
}

/**
 * Module table owned by the caller, keyed by absolute file path.
 */
export type FluxionModuleCache = Map<string, FluxionModule>;

export interface FluxionRequireOptions {
  /**
   * Files inside this directory are loaded by `fluxionRequire` itself: each file is compiled and evaluated on its
   * own, and every `import`/`require` it makes of another file inside `dir` goes through `fluxionRequire` again.
   * Everything else (node_modules, builtins, files outside `dir`) is loaded by the native `require`,
   * so it keeps Node's cache and is NOT hot-reloaded.
   * @default dirname of the entry file
   */
  dir?: string;

  /**
   * The module table used for files inside `dir`. The loader never keeps one of its own, so this is the only
   * place a module can be cached, and the caller decides what stays in it.
   *
   * With a table, a file is loaded fresh the first time it is asked for, and its mtime and size, and those of every
   * file it requires (directly or not), are recorded. Asking for it again compares them with the disk: if any one
   * file differs in either, the cached modules of that whole chain are dropped and the file is loaded fresh;
   * if none changed, the cached exports are returned without touching the file.
   *
   * Content is never compared, so an edit that keeps both mtime and size is not noticed. A file that did not exist
   * before is only picked up when something asks for it, which is also what makes the files requiring it change.
   *
   * You can still edit the table yourself: `cache.delete(file)` or `cache.clear()` make the next call re-evaluate,
   * and every module that required a deleted file counts as changed too.
   *
   * Without it, a fresh table is used per call: nothing survives the call, like PHP re-running a script.
   */
  cache?: FluxionModuleCache;
}

const NODE_MODULES = `${sep}node_modules${sep}`;

const COMPILED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const EXTENSIONS = [...COMPILED, '.json'];
// By TypeScript convention `import './a.js'` points at `a.ts`
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const isBare = (specifier: string) => !specifier.startsWith('.') && !isAbsolute(specifier);

const isChanged = (m: FluxionModule) => {
  try {
    const { mtimeMs, size } = statSync(m.filename);
    return mtimeMs !== m.mtimeMs || size !== m.size;
  } catch {
    // gone counts as changed
    return true;
  }
};

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Find the real file behind an extension-less or `.js`-style path, the way esbuild would.
 */
function findFile(base: string) {
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
}

function compile(file: string) {
  const { outputFiles } = buildSync({
    entryPoints: [file],
    bundle: false,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: 'inline',
    sourcesContent: false,
    logLevel: 'silent',
    // `import(x)` becomes `require(x)`, because a vm function has no way to run a native dynamic import
    supported: { 'dynamic-import': false },
    define: {
      'import.meta.url': JSON.stringify(pathToFileURL(file).href),
      'import.meta.filename': JSON.stringify(file),
      'import.meta.dirname': JSON.stringify(dirname(file)),
    },
  });
  return outputFiles[0].text;
}

/**
 * Load a ts/js file the way PHP runs a script: nothing is remembered unless you hand over a `cache`.
 *
 * The file and every local file under `dir` it imports are compiled by esbuild one by one and evaluated by
 * `fluxionRequire` itself, so each of them gets its own `__dirname`, `__filename` and `import.meta`.
 *
 * It is synchronous, because `require` is: the imports of a file have to be loaded while it is running.
 *
 * The result is the module's `exports`, so `export default x` is available as `result.default`.
 */
export function fluxionRequire(absolutePath: string, options: FluxionRequireOptions = {}): any {
  const entry = resolve(absolutePath);
  const dir = resolve(options.dir ?? dirname(entry));
  const cache = options.cache ?? new Map<string, FluxionModule>();

  const dirPrefix = dir.endsWith(sep) ? dir : dir + sep;
  const isHot = (file: string) => {
    const ext = extname(file);
    return file.startsWith(dirPrefix) && !file.includes(NODE_MODULES) && (COMPILED.has(ext) || ext === '.json');
  };

  /**
   * Return the cached module if nothing in its chain changed, otherwise drop the chain and load it fresh.
   */
  const load = (file: string): FluxionModule => {
    const cached = cache.get(file);
    if (cached === undefined) {
      return loadFresh(file);
    }

    const chain = collectChain(cached);
    if (![...chain].some(isStale)) {
      return cached;
    }
    for (const m of chain) {
      // A newer instance of the same path may have been loaded by someone else meanwhile: that one is fine, keep it
      if (cache.get(m.filename) === m) {
        cache.delete(m.filename);
      }
    }
    return loadFresh(file);
  };

  const collectChain = (root: FluxionModule) => {
    const chain = new Set([root]);
    // a Set visits what is added while iterating, and the `has` check built into it stops cycles
    for (const m of chain) {
      for (const dep of m.deps.values()) {
        chain.add(dep);
      }
    }
    return chain;
  };

  const isStale = (m: FluxionModule) => cache.get(m.filename) !== m || isChanged(m);

  const loadFresh = (file: string): FluxionModule => {
    // Read before the file is, so an edit in between is seen as a change next time instead of being missed
    const { mtimeMs, size } = statSync(file);
    const mod: FluxionModule = { id: file, filename: file, exports: {}, mtimeMs, size, deps: new Map() };
    // Registered before it runs, so a circular import sees the partial exports instead of looping
    cache.set(file, mod);
    try {
      evaluate(file, mod);
    } catch (e) {
      cache.delete(file);
      throw e;
    }
    return mod;
  };

  const evaluate = (file: string, mod: FluxionModule) => {
    const ext = extname(file);
    if (ext === '.json') {
      mod.exports = JSON.parse(readFileSync(file, 'utf8'));
      return;
    }
    if (!COMPILED.has(ext)) {
      throw new Error(`fluxionRequire: unsupported file type "${ext}" (${file})`);
    }

    const fn = compileFunction(compile(file), ['exports', 'require', 'module', '__filename', '__dirname'], {
      filename: file,
    });
    fn.call(mod.exports, mod.exports, createModuleRequire(mod), mod, file, dirname(file));
  };

  const createModuleRequire = (from: FluxionModule) => {
    const native = createRequire(from.filename);
    const locate = (specifier: string) =>
      isBare(specifier) ? undefined : findFile(resolve(dirname(from.filename), specifier));

    const req = (specifier: string) => {
      const file = locate(specifier);
      if (file === undefined) {
        // builtins, packages and anything that cannot be found; the native require reports the latter
        return native(specifier);
      }
      if (!isHot(file)) {
        return native(file);
      }
      const dep = load(file);
      // Also recorded for requires made long after loading (`import()` inside a function)
      from.deps.set(file, dep);
      return dep.exports;
    };
    req.resolve = (specifier: string) => locate(specifier) ?? native.resolve(specifier);
    req.cache = native.cache;
    return req;
  };

  return load(entry).exports;
}
