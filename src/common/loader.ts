import { build, type Plugin } from 'esbuild';
import { compileFunction } from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FluxionRequireOptions {
  /**
   * Files inside this directory are bundled into the entry and re-evaluated on every call (hot).
   * Everything else (node_modules, builtins, files outside `root`) is left external and loaded
   * through the native `require`, so it keeps Node's cache and is NOT hot-reloaded.
   * @default dirname of the entry file
   */
  root?: string;
}

const NODE_MODULES = `${sep}node_modules${sep}`;

const isBare = (specifier: string) => !specifier.startsWith('.') && !isAbsolute(specifier);

function createScopePlugin(entry: string, root: string): Plugin {
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const isHot = (file: string) => file.startsWith(rootPrefix) && !file.includes(NODE_MODULES);

  return {
    name: 'fluxion-scope',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point' || args.pluginData?.fluxionResolving) {
          return;
        }

        const result = await b.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          with: args.with,
          pluginData: { fluxionResolving: true },
        });

        // Unresolvable imports surface esbuild's own error messages
        if (result.errors.length > 0) {
          return result;
        }

        if (!result.external && isHot(result.path)) {
          return { path: result.path, namespace: result.namespace, sideEffects: result.sideEffects };
        }

        // Builtins and bare packages keep their specifier; local files outside root need an absolute path
        return { path: isBare(args.path) ? args.path : result.path, external: true };
      });
    },
  };
}

/**
 * Load a ts/js file with NO module cache at all: the entry and every local file it imports are
 * freshly bundled by esbuild and evaluated on each call, like PHP re-running a script.
 *
 * The result is the module's `exports`, so `export default x` is available as `result.default`.
 */
export async function fluxionRequire(absolutePath: string, options: FluxionRequireOptions = {}) {
  const entry = resolve(absolutePath);
  const root = resolve(options.root ?? dirname(entry));

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: 'inline',
    sourcesContent: false,
    logLevel: 'silent',
    define: {
      'import.meta.url': JSON.stringify(pathToFileURL(entry).href),
      'import.meta.filename': JSON.stringify(entry),
      'import.meta.dirname': JSON.stringify(dirname(entry)),
    },
    plugins: [createScopePlugin(entry, root)],
  });

  const code = result.outputFiles[0].text;
  const module = { exports: {} as any };
  const fn = compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], {
    filename: entry,
  });
  fn(module.exports, createRequire(entry), module, entry, dirname(entry));

  return module.exports;
}
