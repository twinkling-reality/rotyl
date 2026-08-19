/// <reference types="vite/client" />

/**
 * The one variable this build reads, declared rather than left to Vite's index
 * signature, which types every unknown key as `any`.
 *
 * See `src/platform/perception/tracking-host.ts` for what it addresses and why
 * it has no default.
 */
interface ImportMetaEnv {
  readonly VITE_TRACKING_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
