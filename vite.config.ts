import { defineConfig } from 'vite';

// No Preact plugin: the JSX transform is configured in tsconfig.json
// ("jsx": "react-jsx", "jsxImportSource": "preact") and Vite's transformer
// honours it. The plugin exists to add Babel-based Fast Refresh, which is not
// worth reintroducing Babel to this build for.
export default defineConfig({
  build: {
    target: 'es2023',
    assetsInlineLimit: 0,
  },
});
