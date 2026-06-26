import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = {
  '/tools/api': { target: 'http://localhost:3001', changeOrigin: true },
  '/tools/uploads': { target: 'http://localhost:3001', changeOrigin: true },
};

export default defineConfig({
  base: '/tools/',
  plugins: [react()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  build: {
    outDir: 'build',
    emptyOutDir: true
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.ts'
  }
});
