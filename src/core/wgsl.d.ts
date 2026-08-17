/**
 * Shaders are imported as source strings and composed in TypeScript, since
 * WGSL has no include mechanism of its own.
 *
 * Declared here rather than relying on `vite/client` so that `src/core` keeps
 * type-checking under `tsconfig.core.json`, which deliberately has no DOM and
 * no bundler-provided ambient types.
 */
declare module '*.wgsl?raw' {
  const source: string;
  export default source;
}
