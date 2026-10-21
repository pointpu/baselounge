import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/webapp',
  build: { outDir: '../../dist/webapp', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8000', '/media': 'http://localhost:8000' },
  },
});
