import { defineConfig, type Plugin } from 'vite';

// The page's CSP forbids network connections. Only the dev server relaxes it,
// so hot reload can use its local websocket.
const devCsp: Plugin = {
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("connect-src 'self'", "connect-src 'self' ws://localhost:*"),
};

export default defineConfig({
  base: './',
  plugins: [devCsp],
  build: { outDir: 'dist', chunkSizeWarningLimit: 4000 },
});
