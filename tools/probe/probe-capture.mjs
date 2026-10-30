/**
 * 实测：打开指定直播间，旁听它的推送信道，看能不能解出真实弹幕/礼物。
 *
 *   node tools/probe-capture.mjs 633710243936
 *   node tools/probe-capture.mjs 633710243936 917447990954     # 依次试
 *
 * 每个房间最多等 25 秒。只要有一条信道挂上并解出事件，就算通。
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../browser.mjs';
import { decodeFrame } from '../../src/douyin/decode.mjs';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve('data/runtime');
await mkdir(outDir, { recursive: true });

const ids = process.argv.slice(2).filter((x) => /^\d{6,}$/.test(x));
if (!ids.length) {
  console.error('用法：node tools/probe-capture.mjs <房间号> [房间号…]');
  process.exit(1);
}

const launched = await ensureBrowser({ port, headless: false });
const browser = await chromium.connectOverCDP(launched.wsEndpoint, { timeout: 20_000 });

async function tryRoom(roomId) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const stat = { roomId, sockets: [], frames: 0, events: 0, types: new Set(), samples: [], http: 0 };
  let done = false;

  page.on('websocket', (ws) => {
    const url = ws.url();
    if (!/webcast/i.test(url)) return;
    stat.sockets.push(url.slice(0, 100));
    console.log(`  ⚡ [${roomId}] 挂上信道：${url.slice(0, 80)}`);
    ws.on('framereceived', (f) => {
      const payload = f?.payload;
      if (!payload || typeof payload === 'string') return;
      stat.frames++;
      try {
        const { events, meta } = decodeFrame(payload);
        if (meta?.unknown?.length) for (const m of meta.unknown) stat.types.add(`?${m}`);
        for (const e of events) {
          stat.events++;
          stat.types.add(e.type);
          if (stat.samples.length < 8) {
            const line = e.type === 'comment' ? `${e.user?.name}: ${e.text}`
              : e.type === 'gift' ? `${e.user?.name} 送 ${e.giftName} ×${e.count}（${e.totalDiamonds} 抖币）`
              : `${e.type} ${e.user?.name ?? ''}`;
            stat.samples.push(line);
            console.log(`     📨 ${line}`.slice(0, 120));
          }
          done = true;
        }
      } catch (err) {
        stat.types.add(`!${err.message.slice(0, 40)}`);
      }
    });
  });

  page.on('response', (r) => {
    if (/webcast/.test(r.url())) stat.http++;
  });

  const url = `https://live.douyin.com/${roomId}`;
  console.log(`\n[房间 ${roomId}] ${url}`);
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
  } catch (err) {
    console.log('  导航异常：', err.message.slice(0, 90));
  }

  // 最多等 25 秒，拿到事件就提前收工
  for (let i = 0; i < 25 && !done; i++) await page.waitForTimeout(1000);

  const title = await page.title().catch(() => '');
  const finalUrl = page.url();
  await page.screenshot({ path: path.join(outDir, `room-${roomId}.png`) }).catch(() => {});
  await page.close().catch(() => {});

  return { ...stat, title, finalUrl, types: [...stat.types] };
}

const results = [];
for (const id of ids) {
  try {
    const r = await tryRoom(id);
    results.push(r);
    console.log(`  → 信道 ${r.sockets.length} 条，帧 ${r.frames}，事件 ${r.events}，标题「${r.title.slice(0, 30)}」`);
    if (r.events > 0) break;
  } catch (err) {
    console.log(`  ✗ 房间 ${id} 出错：${err.message.slice(0, 100)}`);
  }
}

const win = results.find((r) => r.events > 0);
console.log('\n========== 结论 ==========');
if (win) {
  console.log(`✓ 抓取通了！房间 ${win.roomId}`);
  console.log(`  收到帧 ${win.frames}，解出事件 ${win.events}`);
  console.log(`  消息类型：${win.types.join(', ')}`);
  console.log('  样例：');
  for (const s of win.samples) console.log('   ', s);
} else {
  console.log('✗ 没有从任何房间收到可解的事件');
  for (const r of results) {
    console.log(`  房间 ${r.roomId}: 信道 ${r.sockets.length}，帧 ${r.frames}，webcast 请求 ${r.http}，最终地址 ${r.finalUrl.slice(0, 60)}`);
    if (r.types.length) console.log(`     类型：${r.types.join(', ')}`);
  }
}
process.exit(win ? 0 : 1);
