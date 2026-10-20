import { defineConfig } from 'tsdown';
import replace from '@rollup/plugin-replace';
import pkg from './package.json' with { type: 'json' };

const isDev = process.env.NODE_ENV === 'development';
const plugins = () => [
  (replace as any as typeof replace.default)({
    preventAssignment: true,
    delimiters: ['', ''],
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    __VERSION__: pkg.version,
  }),
];

export default defineConfig([
  {
    entry: [{ index: 'src/index.ts' }],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: !isDev,
    target: 'node24',
    treeshake: !isDev,
    plugins: plugins(),
    deps: {
      onlyBundle: ['type-narrow', 'fast-json-stable-stringify'],
    },
  },
]);
