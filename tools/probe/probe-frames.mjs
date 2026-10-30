/**
 * 帧级诊断：打开一个直播间，把收到的每一帧拆开看。
 *
 *   node tools/probe-frames.mjs 633710243936
 *
 * 打出来的东西：
 *   帧长度、payloadType（msg/hb/ack/…）、payloadEncoding、解压后长度、
 *   Response.messagesList 的条数与每条的 method。
 *
 * 一旦能看到真实 method，就说明 protobuf 字段号是对的；如果 payloadType 全是不认识的
 * 字符串，说明 PushFrame 的字段号错了，得换版本对。
 */
import { chromium } from 'playwright-core';
import { gunzipSync } from 'node:zlib';
import { ensureBrowser } from '../browser.mjs';
import { decodePushFrame, decodeResponse } from '../../src/douyin/proto.mjs';
import { writeFile as wf, mkdir as mk } from 'node:fs/promises';

const roomId = (process.argv[2] || '').trim();
if (!/^\d{6,}$/.test(roomId)) {
  console.error('用法：node tools/probe-frames.mjs <房间号>');
  process.exit(1);
}

const launched = await ensureBrowser({ port: Number(process.env.CDP_PORT || 9333), headless: false });
const browser = await chromium.connectOverCDP(launched.wsEndpoint, { timeout: 20_000 });
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();

const types = new Map();
let shown = 0;
let msgFrames = 0;
const methodCount = new Map();

page.on('websocket', (ws) => {
  if (!/webcast/i.test(ws.url())) return;
  console.log('⚡ 信道：', ws.url().slice(0, 80));
  ws.on('framereceived', async (f) => {
    const buf = f?.payload;
    if (!buf || typeof buf === 'string') return;

    let push;
    try {
      push = decodePushFrame(buf);
    } catch (err) {
      const k = `undecodable(${err.message.slice(0, 30)})`;
      types.set(k, (types.get(k) ?? 0) + 1);
      return;
    }

    const pt = String(push.payloadType || '(空)');
    types.set(pt, (types.get(pt) ?? 0) + 1);

    if (shown < 6) {
      shown++;
      console.log(
        `  帧#${shown} len=${buf.length} type=${JSON.stringify(pt)} enc=${JSON.stringify(String(push.payloadEncoding || ''))} payload=${push.payload?.length ?? 0}B`,
      );
    }

    if (pt !== 'msg') return;
    msgFrames++;

    let body = Buffer.from(push.payload || []);
    if (String(push.payloadEncoding) === 'gzip') {
      try {
        body = gunzipSync(body);
      } catch (e) {
        console.log('  ! gunzip 失败', e.message.slice(0, 40));
        return;
      }
    }

    if (!globalThis.__saved) {
      globalThis.__saved = true;
      await mk('data/runtime', { recursive: true });
      await wf('data/runtime/frame1.bin', body);
      console.log('  💾 已保存首帧解压后内容 → data/runtime/frame1.bin', body.length, 'B');
    }

    let resp;
    try {
      resp = decodeResponse(body);
    } catch (e) {
      console.log('  ! Response 解码失败', e.message.slice(0, 40), 'body', body.length, 'B');
      return;
    }

    const list = resp.messagesList || [];
    if (shown <= 8) {
      console.log(`  msg 帧：解压后 ${body.length}B，messagesList ${list.length} 条`);
    }
    for (const m of list) {
      const method = String(m.method || '(无)');
      methodCount.set(method, (methodCount.get(method) ?? 0) + 1);
      if (methodCount.get(method) <= 2) {
        console.log(`     · ${method}  payload ${m.payload?.length ?? 0}B`);
      }
    }
  });
});

await page.goto(`https://live.douyin.com/${roomId}`, { waitUntil: 'commit', timeout: 30_000 }).catch((e) => console.log('导航异常：', e.message.slice(0, 80)));
await page.waitForTimeout(22_000);

console.log('\n===== payloadType 分布 =====');
for (const [k, v] of [...types].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(3)} × ${k}`);
console.log(`\nmsg 帧 ${msgFrames} 个`);

console.log('\n===== 解出的 method =====');
if (!methodCount.size) console.log('  (无)');
for (const [k, v] of [...methodCount].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(3)} × ${k}`);

await page.close().catch(() => {});
process.exit(0);
