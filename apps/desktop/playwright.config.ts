/**
 * End-to-end tests of the app in the browser (dev server). Run:
 *   npx playwright test            (starts `vite --port 5401` unless one is already running)
 *   HH_E2E_PORT=1420 npx playwright test   (against another dev server)
 */
import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.HH_E2E_PORT ?? 5401);

// Chromium needs NSS/NSPR; on machines without them system-wide we keep user-local copies (see scripts/shot.mjs).
const localLibs = join(homedir(), '.local/share/hh-browser-libs/root/usr/lib/x86_64-linux-gnu');
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
if (existsSync(localLibs)) env.LD_LIBRARY_PATH = [localLibs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1320, height: 840 },
    launchOptions: { env },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1320, height: 840 } } }],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    port,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
