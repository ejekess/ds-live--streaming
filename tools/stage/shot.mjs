/**
 * 舞台截图 / 冒烟检查。
 *
 * 走 tools/browser.mjs：把本机 Edge 起成调试端口，再用 connectOverCDP 连上去。
 * 等模型真的加载完（window.DSHPet.state.modelSize 有值）再截图，并回读内部状态。
 *
 * 用法：
 *   node tools/shot.mjs                    # 透明背景（OBS 实际画面）
 *   node tools/shot.mjs --bg               # 加背景，方便肉眼看
 *   node tools/shot.mjs --w=1920 --h=1080 --wait=5000
 *   node tools/shot.mjs --url=http://127.0.0.1:8787/avatar?h=900
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../browser.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const url = opt('url', 'http://127.0.0.1:8787/avatar');
const out = path.resolve(opt('out', 'data/runtime/stage.png'));
const withBg = args.includes('--bg');
const width = Number(opt('w', 1600));
const height = Number(opt('h', 900));
const waitMs = Number(opt('wait', 4000));
const port = Number(process.env.CDP_PORT || 9222);

await mkdir(path.dirname(out), { recursive: true });

const launched = await ensureBrowser({ port, headless: true });
const browser = await chromium.connectOverCDP(launched.wsEndpoint);
const context = browser.contexts()[0] ?? (await browser.newContext());
await context.setDefaultTimeout(45_000);

const page = await context.newPage();
await page.setViewportSize({ width, height });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let ready = false;
let failure = '';
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.DSHPet?.state?.modelSize), null, { timeout: 40_000 });
  ready = true;
} catch (err) {
  failure = err.message;
}

if (withBg) {
  await page.addStyleTag({
    content:
      'html,body{background:radial-gradient(circle at 50% 28%, #1b2a4a 0%, #0a1020 62%, #05080f 100%) !important;}',
  });
}

await page.waitForTimeout(waitMs);

const info = await page.evaluate(() => {
  const pet = window.DSHPet;
  return {
    ready: Boolean(pet?.state?.modelSize),
    modelSize: pet?.state?.modelSize ?? null,
    mood: pet?.state?.mood ?? null,
    face: pet?.state?.face ?? null,
    motion: pet?.state?.motion ?? null,
    hasAct: typeof pet?.act === 'function',
    expressions: pet?.catalog ? pet.catalog().expressions?.length ?? 0 : 0,
    motions: pet?.catalog ? pet.catalog().motions ?? [] : [],
    petError: window.__DSHPetError ?? null,
    canvasCount: document.querySelectorAll('canvas').length,
    canvasBox: (() => {
      const c = document.querySelector('#dsh-live2d-pet canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    })(),
  };
});

await page.screenshot({ path: out });
await page.close();

console.log(JSON.stringify({ ok: ready, failure: failure || null, out, ...info }, null, 2));
if (!ready) {
  console.log('--- page logs (last 25) ---');
  console.log(logs.slice(-25).join('\n'));
  process.exit(1);
}
