#!/usr/bin/env node
/**
 * Generates the HHereditas app icon: a macOS-style squircle with a stylised plasmid ring
 * (backbone + coloured feature arcs with arrowheads), rendered to a 1024×1024 PNG with
 * headless Chromium. Then run `npx tauri icon tools/icon/icon.png` inside apps/desktop to
 * produce every platform size (.ico, .icns, PNGs).
 *
 *   node tools/icon/make-icon.mjs
 */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const C = 512;

const rad = (deg) => ((deg - 90) * Math.PI) / 180; // 0° = 12 o'clock, clockwise
const pt = (r, deg) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))];
const f = (n) => n.toFixed(2);

/** A thick arc band from a1 to a2 (clockwise) ending in a flared, pointed arrowhead at a2. */
function arrowArc(r, width, a1, a2, head = 13, flare = 12) {
  const ro = r + width / 2;
  const ri = r - width / 2;
  const aHead = a2 - head;
  const large = aHead - a1 > 180 ? 1 : 0;
  const [x1, y1] = pt(ro, a1);
  const [x2, y2] = pt(ro, aHead);
  const [fx1, fy1] = pt(ro + flare, aHead);
  const [tx, ty] = pt(r, a2);
  const [fx2, fy2] = pt(ri - flare, aHead);
  const [x3, y3] = pt(ri, aHead);
  const [x4, y4] = pt(ri, a1);
  return [
    `M ${f(x1)} ${f(y1)}`,
    `A ${ro} ${ro} 0 ${large} 1 ${f(x2)} ${f(y2)}`,
    `L ${f(fx1)} ${f(fy1)}`,
    `L ${f(tx)} ${f(ty)}`,
    `L ${f(fx2)} ${f(fy2)}`,
    `L ${f(x3)} ${f(y3)}`,
    `A ${ri} ${ri} 0 ${large} 0 ${f(x4)} ${f(y4)}`,
    'Z',
  ].join(' ');
}

const R = 236;
const W = 58;
const arcs = [
  { a1: -62, a2: 52, color: '#F5B841' }, // CDS amber
  { a1: 66, a2: 128, color: '#5BBF6A' }, // promoter green
  { a1: 142, a2: 226, color: '#5AC8FA' }, // origin sky
  { a1: 240, a2: 284, color: '#FF6B5E' }, // terminator coral
];

const ticks = Array.from({ length: 24 }, (_, i) => {
  const a = i * 15;
  const [x1, y1] = pt(R - W / 2 - 22, a);
  const [x2, y2] = pt(R - W / 2 - (i % 6 === 0 ? 46 : 34), a);
  return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="rgba(255,255,255,${i % 6 === 0 ? 0.55 : 0.28})" stroke-width="${i % 6 === 0 ? 7 : 5}" stroke-linecap="round"/>`;
}).join('\n    ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2F6BFF"/>
      <stop offset="1" stop-color="#1A2F86"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0.12" r="0.75">
      <stop offset="0" stop-color="rgba(255,255,255,0.28)"/>
      <stop offset="1" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.32"/>
    </filter>
    <filter id="arcShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#06103a" flood-opacity="0.45"/>
    </filter>
  </defs>
  <g filter="url(#shadow)">
    <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
    <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#sheen)"/>
  </g>
  <g>
    ${ticks}
    <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="14"/>
    <g filter="url(#arcShadow)">
      ${arcs.map((a) => `<path d="${arrowArc(R, W, a.a1, a.a2)}" fill="${a.color}"/>`).join('\n      ')}
    </g>
    <text x="${C}" y="${C + 34}" text-anchor="middle" font-family="Inter, -apple-system, sans-serif" font-weight="700" font-size="104" fill="#ffffff" letter-spacing="-2">HH</text>
  </g>
</svg>`;

writeFileSync(join(here, 'icon.svg'), svg);

const localLibs = join(homedir(), '.local/share/hh-browser-libs/root/usr/lib/x86_64-linux-gnu');
const env = { ...process.env };
if (existsSync(localLibs)) env.LD_LIBRARY_PATH = [localLibs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const browser = await chromium.launch({ env });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.screenshot({ path: join(here, 'icon.png'), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
console.log('wrote tools/icon/icon.svg and tools/icon/icon.png');
