/**
 * 探测器：打开抖音直播广场，找出正在直播的房间。
 *
 * 比 probe-room 更啰嗦、更稳：每一步都打日志，卡在哪一眼能看出来。
 * 顺便截一张图，能看到页面到底长什么样（风控页 / 登录墙 / 正常广场）。
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../browser.mjs';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve('data/runtime');
await mkdir(outDir, { recursive: true });

console.log('[1/5] 启动/复用浏览器…');
const launched = await ensureBrowser({ port, headless: false });
console.log('     CDP:', launched.wsEndpoint);

console.log('[2/5] 连接…');
const browser = await chromium.connectOverCDP(launched.wsEndpoint, { timeout: 20_000 });
const context = browser.contexts()[0] ?? (await browser.newContext());
console.log('     contexts:', browser.contexts().length, '| pages:', context.pages().length);

console.log('[3/5] 打开直播广场…');
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(25_000);
page.on('pageerror', (e) => console.log('     [pageerror]', e.message.slice(0, 100)));

try {
  await page.goto('https://live.douyin.com/', { waitUntil: 'commit', timeout: 30_000 });
  console.log('     已提交导航 →', page.url());
} catch (err) {
  console.log('     导航失败：', err.message.slice(0, 120));
}

await page.waitForTimeout(6000);
console.log('[4/5] 页面标题：', (await page.title().catch(() => '(取不到)')));

const shotPath = path.join(outDir, 'douyin-plaza.png');
await page.screenshot({ path: shotPath }).catch((e) => console.log('     截图失败：', e.message.slice(0, 80)));
console.log('     截图：', shotPath);

console.log('[5/5] 找房间链接…');
const rooms = await page
  .$$eval('a[href]', (nodes) =>
    nodes
      .map((a) => {
        const href = a.getAttribute('href') ?? '';
        const m = href.match(/^\/(\d{6,})$/);
        if (!m) return null;
        return {
          roomId: m[1],
          text: (a.getAttribute('aria-label') || a.title || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
        };
      })
      .filter(Boolean),
  )
  .catch((e) => {
    console.log('     取链接失败：', e.message.slice(0, 100));
    return [];
  });

const seen = new Set();
const uniq = rooms.filter((r) => (seen.has(r.roomId) ? false : seen.add(r.roomId)));
console.log(`     共 ${uniq.length} 个房间`);
for (const r of uniq.slice(0, 12)) console.log(`     ${r.roomId}  ${r.text || '(无标题)'}`);

if (uniq.length) {
  console.log('\n拿这个房间试抓取：');
  console.log(`  node tools/probe-capture.mjs ${uniq[0].roomId}`);
}
await page.close().catch(() => {});
