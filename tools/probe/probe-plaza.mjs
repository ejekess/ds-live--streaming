/**
 * 探测器：从抖音直播广场的**网络响应**里捞出正在直播的房间号。
 *
 * 广场的卡片是 JS 渲染的，没有 <a href="/房间号">，所以直接正则扫响应体里的 web_rid。
 * 顺便把正在播放的直播间的 WS 也挂上，看推送信道通不通。
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../browser.mjs';
import { decodeFrame } from '../../src/douyin/decode.mjs';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve('data/runtime');
await mkdir(outDir, { recursive: true });

const rooms = new Map();
const sockets = [];
const frames = { total: 0, decoded: 0, events: 0, methods: new Set() };

const launched = await ensureBrowser({ port, headless: false });
const browser = await chromium.connectOverCDP(launched.wsEndpoint, { timeout: 20_000 });
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(25_000);

// ① 响应体里找 web_rid
page.on('response', async (res) => {
  const url = res.url();
  if (!/douyin\.com/.test(url)) return;
  const ct = res.headers()['content-type'] ?? '';
  if (!/json|javascript|text/.test(ct)) return;
  try {
    const body = await res.text();
    if (!body.includes('web_rid')) return;
    for (const m of body.matchAll(/"web_rid"\s*:\s*"(\d+)"/g)) {
      if (!rooms.has(m[1])) rooms.set(m[1], { roomId: m[1], from: url.slice(0, 60) });
    }
    for (const m of body.matchAll(/"nickname"\s*:\s*"([^"]{1,20})"/g)) {
      // 只做点缀，不追求准确
      void m;
    }
  } catch {
    /* 响应体读不到就算了 */
  }
});

// ② 旁听页面自己发起的推送信道
page.on('websocket', (ws) => {
  const url = ws.url();
  if (!/webcast\/im\/push|\/webcast\/im\//i.test(url)) return;
  sockets.push(url);
  console.log('  ⚡ 挂上推送信道：', url.slice(0, 80));
  ws.on('framereceived', (f) => {
    const payload = f?.payload;
    if (!payload || typeof payload === 'string') return;
    frames.total++;
    try {
      const { events, meta } = decodeFrame(payload);
      for (const m of meta.unknown) frames.methods.add(`?${m}`);
      if (events.length) {
        frames.decoded++;
        frames.events += events.length;
        for (const e of events.slice(0, 2)) {
          frames.methods.add(e.type);
          if (frames.decoded <= 6) {
            console.log(`  📨 ${e.type}: ${e.text ?? e.giftName ?? e.user?.name ?? ''}`.slice(0, 100));
          }
        }
      }
    } catch (err) {
      frames.methods.add(`!${err.message.slice(0, 30)}`);
    }
  });
});

console.log('打开直播广场…');
await page.goto('https://live.douyin.com/', { waitUntil: 'commit', timeout: 30_000 }).catch((e) => console.log('  导航异常：', e.message.slice(0, 80)));
await page.waitForTimeout(12_000);

console.log(`\n发现 ${rooms.size} 个房间号`);
const list = [...rooms.values()].slice(0, 20);
for (const r of list) console.log('  ', r.roomId, r.from);

console.log(`\n推送信道 ${sockets.length} 条 | 收到帧 ${frames.total} | 解出事件 ${frames.events}`);
console.log('解出的消息类型：', [...frames.methods].join(', ') || '(无)');

await page.screenshot({ path: path.join(outDir, 'douyin-plaza2.png') }).catch(() => {});
await writeFile(path.join(outDir, 'douyin-rooms.json'), JSON.stringify({ rooms: list, sockets, frames: { ...frames, methods: [...frames.methods] } }, null, 2), 'utf8');

if (list.length) console.log(`\n下一步：node tools/probe-capture.mjs ${list[0].roomId}`);
await page.close().catch(() => {});
