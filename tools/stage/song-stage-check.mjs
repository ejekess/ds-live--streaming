/**
 * 浏览器端的语音/点歌验收：开一个真页面，让它当"观众"。
 *
 *   node tools/song-stage-check.mjs
 *
 * 验的是三件事（离线自检验不到的）：
 *   1. 加了 audio 模块之后舞台页还能不能正常起 Live2D（有没有 JS 报错）；
 *   2. <audio> 能不能真的播（自动播放策略、URL 编码、MIME）；
 *   3. 播放结束的 audio-done 是**真的 ended 事件**回来的，而不是 15 秒超时兜底。
 *
 * 第 3 点最关键：如果 reason=timeout，说明回执链路没通。
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../browser.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const outDir = path.resolve('data/runtime');
const port = Number(process.env.CDP_PORT || 9222);
// 放不存在的歌：走占位渲染（8s）+ 6 秒短音频，才能在合理时间内验到 ended
const song = process.argv[2] ?? '测试用的短曲目';

await mkdir(outDir, { recursive: true });

const launched = await ensureBrowser({ port, headless: true });
const browser = await chromium.connectOverCDP(launched.wsEndpoint);
const context = browser.contexts()[0] ?? (await browser.newContext());
context.setDefaultTimeout(60_000);

const page = await context.newPage();
await page.setViewportSize({ width: 1600, height: 900 });

const errors = [];
const badResponses = [];
page.on("response", (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
});

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const state = () => fetch(`${BASE}/api/state`).then((r) => r.json());

let report = {};
try {
  await page.goto(`${BASE}/avatar?h=780&corner=br`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.DSHPet?.state?.modelSize), null, { timeout: 45_000 });
  console.log(`${ts()} 舞台就绪，模型已加载`);
  await page.waitForTimeout(1500);

  const before = await state();
  console.log(`${ts()} 点歌前 audio=${before.state.audio?.mode} songs.size=${before.state.songs?.size}`);

  const req = await fetch(`${BASE}/api/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'song', song, tier: 4, name: '浏览器观众' }),
  }).then((r) => r.json());
  console.log(`${ts()} 点歌：${JSON.stringify(req.result ?? req)}`);

  // 等它真的开始唱，唱起来那一刻截图（这时才有歌+动作+可能的气泡）
  let singing = false;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(500);
    const st = await state();
    if (st.state?.audio?.mode === 'singing') {
      singing = true;
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(outDir, 'stage-singing.png') });
      console.log(`${ts()} 正在唱，已截图`);
      break;
    }
  }
  if (!singing) console.log(`${ts()} 25 秒内没进入唱歌状态`);

  // 再等到播放结束
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    const st = await state();
    if (st.state?.lastSong?.at) break;
  }

  const after = await state();
  const musicEl = await page.evaluate(() => window.__DSH_STAGE__?.audio?.state?.() ?? null);

  await page.screenshot({ path: path.join(outDir, 'stage-song.png') });

  report = {
    song,
    request: req.result ?? req,
    lastSong: after.state.lastSong,
    audioMode: after.state.audio?.mode,
    queue: after.state.songs,
    audioElements: musicEl,
    errors,
    badResponses,
  };
} catch (err) {
  report = { error: String(err?.message || err), errors };
} finally {
  await page.close().catch(() => {});
}

console.log(JSON.stringify(report, null, 2));

const reason = report.lastSong?.reason;
const okPlayed = reason === 'ended';
console.log(okPlayed ? '✓ 由 ended 事件正常结束（回执链路通）' : `✗ 结束原因：${reason ?? '无'}`);
process.exit(okPlayed && report.errors.length === 0 ? 0 : 1);
