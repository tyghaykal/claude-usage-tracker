import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * Defaults suit `npm run dev` on the host. Every value is overridable by env so
 * the same config runs inside the dev container, where the dev server must bind
 * 0.0.0.0, proxy to the `api` service rather than localhost, and tell the HMR
 * client which *published* port the browser actually reached it on.
 */
const num = (value: string | undefined, fallback: number) =>
  value === undefined ? fallback : Number(value);

const hmrClientPort = process.env.VITE_HMR_CLIENT_PORT;

export default defineConfig({
  plugins: [vue()],
  server: {
    host: process.env.VITE_HOST ?? 'localhost',
    port: num(process.env.VITE_PORT, 5173),
    // In Docker the container port (80) differs from the published host port,
    // and without this the HMR websocket dials the wrong one and silently
    // falls back to full reloads.
    hmr: hmrClientPort ? { clientPort: Number(hmrClientPort) } : true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
        // /api/ws is a real WebSocket, not just XHR — Vite's proxy needs this
        // flag to forward the upgrade instead of 400ing it.
        ws: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
