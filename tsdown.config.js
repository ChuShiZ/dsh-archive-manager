import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/index.js'],
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    format: 'esm',
    platform: 'node',
    dts: false,
  },
  {
    entry: ['src/client/index.js'],
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    minify: false,
    format: 'iife',
    platform: 'browser',
    globalName: '__dshArchiveManagerClient',
    external: ['react'],
    banner: `window.__ModuleLoader__.load({ id: "@chushiz/dsh-archive-manager", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    footer: `module.exports = __dshArchiveManagerClient; return module.exports; } });`,
  },
]);
