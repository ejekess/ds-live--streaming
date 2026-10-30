/**
 * 游戏舞台验收：开真浏览器，跑一局反向猜词，在「选题」和「回答」两个阶段各截一张图。
 *
 *   node tools/game-stage-check.mjs
 *
 * 验的是：
 *   1. 词板在反向模式下**正面朝观众**（显示答案），她拿不到；
 *   2. 三个候选问题 / 四个联想选项都画在屏幕上；
 *   3. 整局没有 JS 报错。
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../browser.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const outDir = path.resolve('data/runtime');
const port = Number(process.env.CDP_PORT || 9222);
const FAST = { pickMs: 9000, askMs: 3000, answerMs: 9000, revealMs: 5000, rounds: 3 };
const REAL = { pickMs: 10000, askMs: 4000, answerMs: 15000, revealMs: 8000, rounds: 5 };

await mkdir(outDir, { recursive: true });
const post = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const state = () => fetch(`${BASE}/api/state`).then((r) => r.json());

await post('/api/config', { patch: { 'games.phases': FAST } });

const launched = await ensureBrowser({ port, headless: true });
const browser = await chromium.connectOverCDP(launched.wsEndpoint);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 1600, height: 900 });

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

let report = {};
try {
  await page.goto(`${BASE}/avatar?h=780&corner=br`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.DSHPet?.state?.modelSize), null, { timeout: 45_000 });
  await page.waitForTimeout(1200);

  const started = await post('/api/manual', { kind: 'game' });
  console.log('开局：', JSON.stringify(started));

  // 等进入 pick 阶段
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    const st = await state();
    if (st.state?.games?.phase === 'pick') break;
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, 'game-pick.png') });

  const pickUi = await page.evaluate(() => ({
    card: document.querySelector('.game-card-face')?.textContent ?? null,
    meta: document.querySelector('.game-card-meta')?.textContent ?? null,
    hint: document.querySelector('.game-hint')?.textContent ?? null,
    options: [...document.querySelectorAll('#game .game-opt .t')].map((n) => n.textContent),
    visible: document.getElementById('game')?.classList.contains('on') ?? false,
  }));

  // 等进入 answer 阶段
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    const st = await state();
    if (st.state?.games?.phase === 'answer') break;
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, 'game-answer.png') });

  const answerUi = await page.evaluate(() => ({
    card: document.querySelector('.game-card-face')?.textContent ?? null,
    hint: document.querySelector('.game-hint')?.textContent ?? null,
    options: [...document.querySelectorAll('#game .game-opt .t')].map((n) => n.textContent),
    result: document.querySelector('.game-result')?.textContent ?? null,
  }));

  report = { pickUi, answerUi, errors };
} catch (err) {
  report = { error: String(err?.message || err), errors };
} finally {
  await page.close().catch(() => {});
  await post('/api/manual', { kind: 'game', action: 'stop' }).catch(() => {});
  await post('/api/config', { patch: { 'games.phases': REAL } });
}

console.log(JSON.stringify(report, null, 2));
const okWord = report.pickUi?.card && report.pickUi.card !== '?';
const okOptions = (report.pickUi?.options?.length ?? 0) === 3 && (report.answerUi?.options?.length ?? 0) === 4;
console.log(okWord && okOptions && !report.errors?.length ? '✓ 词板显示 + 选项渲染正常' : '✗ 有问题');
process.exit(okWord && okOptions && !report.errors?.length ? 0 : 1);
