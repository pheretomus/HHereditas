#!/usr/bin/env node
/**
 * Take a screenshot of the running dev server (gallery story or the full app) with
 * headless Chromium, so UI work can be checked visually without a display.
 *
 * Usage:
 *   node apps/desktop/scripts/shot.mjs --story CircularMap/pFA6a-kanMX6 --out /tmp/x.png
 *   node apps/desktop/scripts/shot.mjs --app --theme dark --platform mac --out app.png
 *   node apps/desktop/scripts/shot.mjs --url "http://localhost:5101/?gallery" --out index.png
 * Options:
 *   --port N          dev server port (default 1420); start one with:
 *                     npx vite --port N --strictPort   (inside apps/desktop)
 *   --story File/Name gallery story (File = name of the *.gallery.tsx file without extension)
 *   --app             the real application instead of a story
 *   --query "a=b&c=d" extra query parameters
 *   --theme light|dark, --platform mac|windows|linux
 *   --width 1320 --height 840 --scale 2
 *   --wait 300        extra milliseconds to wait after the page is ready
 *   --full            capture the full scrollable page
 *   --out file.png    output path (default ./shot.png)
 * Prints console errors from the page so broken renders are noticed.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const port = opt('port', '1420');
const query = new URLSearchParams(opt('query', ''));
const theme = opt('theme');
const platform = opt('platform');
if (theme) query.set('theme', theme);
if (platform) query.set('platform', platform);

let url = opt('url');
if (!url) {
  const story = opt('story');
  if (story && !flag('app')) {
    const [file, ...rest] = story.split('/');
    query.set('gallery', file);
    if (rest.length) query.set('story', rest.join('/'));
  }
  url = `http://localhost:${port}/?${query.toString()}`;
}

// Chromium needs NSS/NSPR; on machines where they are not installed system-wide we keep
// user-local copies (see docs/DEVELOPMENT.md).
const localLibs = join(homedir(), '.local/share/hh-browser-libs/root/usr/lib/x86_64-linux-gnu');
const env = { ...process.env };
if (existsSync(localLibs)) env.LD_LIBRARY_PATH = [localLibs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');

const width = Number(opt('width', '1320'));
const height = Number(opt('height', '840'));
const scale = Number(opt('scale', '2'));
const out = opt('out', 'shot.png');

const browser = await chromium.launch({ env });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.stack ?? e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  if (query.has('gallery') && query.get('gallery')) {
    await page.waitForSelector('[data-gallery-ready="true"]', { timeout: 15000 }).catch(() => {
      problems.push('[shot] story did not render [data-gallery-ready]');
    });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(Number(opt('wait', '300')));
  await page.screenshot({ path: out, fullPage: flag('full') });
  console.log(`saved ${out} (${url})`);
  for (const p of problems) console.log(p);
} finally {
  await browser.close();
}
