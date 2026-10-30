/**
 * 截宣传图：待机 / 开场 / 选题 / 投票 / 揭晓。
 *
 *   node tools/stage/shots-doc.mjs
 *
 * 输出到 docs/screenshots/，README 直接引用。
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../browser.mjs';

const BASE = 'http://127.0.0.1:8787';
const OUT = path.resolve('docs/screenshots');
await mkdir(OUT, { recursive: true });

const post = (p, b) =>
  fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const state = () => fetch(BASE + '/api/state').then((r) => r.json());
const waitFor = async (pred, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const j = await state();
    if (pred(j.state?.games ?? {})) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

// 让截图稳定：固定节奏
await post('/api/config', {
  patch: {
    'games.cooldownMs': 1000,
    'games.phases': { startMs: 4000, pickMs: 7000, askMs: 3000, answerMs: 9000, revealMs: 9000, rounds: 3, decideTimeoutMs: 6000 },
  },
});

const launched = await ensureBrowser({ port: 9222, headless: true });
const browser = await chromium.connectOverCDP(launched.wsEndpoint);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
await page.goto(`${BASE}/avatar?bg=gradient`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.DSHPet?.state?.modelSize), null, { timeout: 45_000 });
await page.waitForTimeout(1500);

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('  📸', name);
};

// 1) 待机：常驻说明
await shot('game-0-idle.png');

// 2) 开局
await post('/api/manual', { kind: 'game', giver: '海盐汽水' });
await waitFor((g) => g.phase === 'start', 5000);
await page.waitForTimeout(900);
await shot('game-1-start.png');

// 3) 选题
await waitFor((g) => g.phase === 'pick', 8000);
await page.waitForTimeout(700);
await shot('game-2-pick.png');

// 投三票让她进入提问
for (const k of ['2', '2', '3']) {
  await post('/api/manual', { kind: 'comment', text: k, user: { id: 'shot' + k, name: '观众' + k } });
}

// 4) 投票
await waitFor((g) => g.phase === 'answer', 12000);
for (const k of ['1', '1', '2', '4']) {
  await post('/api/manual', { kind: 'comment', text: k, user: { id: 'v' + k + Math.random(), name: '观众' } });
}
await page.waitForTimeout(1200);
await shot('game-3-vote.png');

// 5) 揭晓（等这一局走完）
await waitFor((g) => g.phase === 'reveal' || g.phase === 'done', 60000);
await page.waitForTimeout(800);
await shot('game-4-reveal.png');

await page.close();
console.log('完成 →', OUT);
process.exit(0);
