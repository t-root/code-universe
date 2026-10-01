import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Every node has its own path (/css/backgrounds-effects/...). GitHub Pages
// answers an unknown path with 404.html, so that is the app too.
const spaFallback = () => {
  let outDir;
  return {
    name: 'spa-404-fallback',
    apply: 'build',
    configResolved: (config) => {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: () => copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html')),
  };
};

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/code-universe/' : '/',
  plugins: [react(), spaFallback()],
  server: {
    port: 5199,
    strictPort: true,
    open: false,
    // Cloudflare Quick Tunnels use a random *.trycloudflare.com hostname.
    // Allow that host while the local development server is shared over HTTPS.
    allowedHosts: ['.trycloudflare.com'],
  },
  preview: {
    port: 5199,
    strictPort: true,
  },
  build: {
    target: 'es2020',
  },
}));
