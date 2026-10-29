import net from 'node:net';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tauri expects a fixed dev-server port; TAURI_DEV_HOST is set when developing for mobile devices.
const host = process.env.TAURI_DEV_HOST;
const DEV_PORT = 1420;

// Before binding, Vite checks the port by briefly listening on 0.0.0.0 and :: and closing again. Under WSL's mirrored
// networking that probe makes WSL tear the port's mirror down about a minute later, which cuts the dev server off
// (connections refused or hanging, from Linux and from Windows). The probe is skipped for the dev port; a port that
// is really taken still fails when Vite binds it (strictPort).
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
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // WebView2 (Windows) is evergreen Chromium; macOS 13+ ships Safari 16.4+ (needed for CSS color-mix).
    target: ['es2022', 'chrome111', 'safari16.4'],
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
