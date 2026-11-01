import net from 'node:net';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed dev-server port; TAURI_DEV_HOST is set by `tauri android dev` so the device can reach us.
// 1430 keeps this app's dev server apart from the desktop app's (1420) so both can run at once.
const host = process.env.TAURI_DEV_HOST;
const DEV_PORT = 1430;

// Same WSL mirrored-networking workaround as apps/desktop/vite.config.ts: skip Vite's wildcard port probe.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '0000:0000:0000:0000:0000:0000:0000:0000']);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  const isProbe = Object.getPrototypeOf(this) === net.Server.prototype;
  if (isProbe && args[0] === DEV_PORT && typeof args[1] === 'string' && WILDCARD_HOSTS.has(args[1])) {
    process.nextTick(() => this.emit('listening'));
    return this;
  }
  return listen.apply(this, args as Parameters<typeof listen>);
} as typeof listen;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1431 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Android System WebView is evergreen Chromium.
    target: ['es2022', 'chrome111'],
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
