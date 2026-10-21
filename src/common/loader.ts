import { buildSync } from 'esbuild';
import { compileFunction } from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NormalizedFluxionOptions } from '@/types.js';

/**
 * A module loaded by `fluxionRequire`. `deps` holds the instances it required, so a stale dependency shows up
 * even when the cache has already been refilled.
 */
export interface LoadedModule {
  id: string;
  filename: string;
  exports: any;
  mtimeMs: number;
  size: number;
  deps: Map<string, LoadedModule>;
}

/**
 * Every loaded module, keyed by absolute path, shared by all fluxion instances. Delete an entry to force a reload.
 */
export const moduleCache = new Map<string, LoadedModule>();

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

const isChanged = (m: LoadedModule) => {
  try {
    const s = statSync(m.filename);
    return s.mtimeMs !== m.mtimeMs || s.size !== m.size;
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
    // TODO 这里最好能配置
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
 * Load a ts/js file under `options.dir`. Local files it imports are loaded the same way, each compiled by esbuild on
 * its own; node_modules, builtins and files outside `dir` go through the native `require`.
 *
 * A file is loaded fresh the first time and its mtime and size are recorded together with those of every file it
 * required. Asking again compares them: if any one differs, the whole chain is dropped and loaded fresh, otherwise
 * the cached exports are returned. Content is never compared.
 *
 * Synchronous, because `require` is. The result is `exports`, so `export default x` is `result.default`.
 */
export function fluxionRequire(absolutePath: string, options: Pick<NormalizedFluxionOptions, 'dir'>): any {
  const entry = resolve(absolutePath);
  const dir = options.dir;

  const dirPrefix = dir.endsWith(sep) ? dir : dir + sep;
  const isHot = (file: string) => {
    const ext = extname(file);
    return file.startsWith(dirPrefix) && !file.includes(NODE_MODULES) && (COMPILED.has(ext) || ext === '.json');
  };

  /**
   * Return the cached module if nothing in its chain changed, otherwise drop the chain and load it fresh.
   */
  const load = (file: string): LoadedModule => {
    const cached = moduleCache.get(file);
    if (cached === undefined) {
      return loadFresh(file);
    }

    const chain = collectChain(cached);
    if (![...chain].some(isStale)) {
      return cached;
    }
    for (const m of chain) {
      // A newer instance of the same path may have been loaded by someone else meanwhile: that one is fine, keep it
      if (moduleCache.get(m.filename) === m) {
        moduleCache.delete(m.filename);
      }
    }
    return loadFresh(file);
  };

  const collectChain = (root: LoadedModule) => {
    const chain = new Set([root]);
    // a Set visits what is added while iterating, and the `has` check built into it stops cycles
    for (const m of chain) {
      for (const dep of m.deps.values()) {
        chain.add(dep);
      }
    }
    return chain;
  };

  const isStale = (m: LoadedModule) => moduleCache.get(m.filename) !== m || isChanged(m);

  const loadFresh = (file: string): LoadedModule => {
    // Read before the file is, so an edit in between is seen as a change next time instead of being missed
    const { mtimeMs, size } = statSync(file);
    const mod: LoadedModule = { id: file, filename: file, exports: {}, mtimeMs, size, deps: new Map() };
    // Registered before it runs, so a circular import sees the partial exports instead of looping
    moduleCache.set(file, mod);
    try {
      evaluate(file, mod);
    } catch (e) {
      moduleCache.delete(file);
      throw e;
    }
    return mod;
  };

  const evaluate = (file: string, mod: LoadedModule) => {
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

  const createModuleRequire = (from: LoadedModule) => {
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
