/**
 * 反向猜词端到端演示（假舞台，不用浏览器）。
 *
 *   node tools/reverse-demo.mjs
 *
 * 走完整链路：选题投票 → 她问 → 观众回答 → 下一轮 → 系统揭晓。
 * 默认用快速时序（约 15 秒一局），跑完自动还原。
 */
import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const FAST = { pickMs: 1500, askMs: 900, answerMs: 1600, revealMs: 1200, rounds: 3 };
const REAL = { pickMs: 10000, askMs: 4000, answerMs: 15000, revealMs: 8000, rounds: 5 };

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

await post('/api/config', { patch: { 'games.phases': FAST } });

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?role=stage`);
let viewer = 0;

ws.on('open', async () => {
  console.log(`${ts()} 假舞台已连接`);
  const r = await post('/api/manual', { kind: 'game' });
  console.log(`${ts()} 开局：${JSON.stringify(r)}`);
  if (!r.ok) process.exit(1);
});

ws.on('message', async (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type !== 'game') return;

  if (msg.action === 'pick') {
    console.log(`${ts()} 🎯 第 ${msg.round}/${msg.totalRounds} 轮（${msg.category} · ${msg.length} 个字）词板显示：${msg.word ?? '(无)'}`);
    msg.options.forEach((o) => console.log(`      ${o.key}. ${o.text}`));
    for (const key of ['1', '2', '3']) {
      await post('/api/manual', { kind: 'comment', text: key, user: { id: `v${++viewer}`, name: `观众${viewer}` } });
    }
  } else if (msg.action === 'ask') {
    console.log(`${ts()} 🗣 她问：${msg.question}？`);
  } else if (msg.action === 'answer') {
    console.log(`${ts()} 🗳 等回答（${msg.options.map((o) => `${o.key}.${o.text}`).join(' ')}）`);
    // 按选项键投：两票 1、一票 2、一票弃权（4）
    const votes = ['1', '1', '2', '4'];
    for (const text of votes) {
      await post('/api/manual', { kind: 'comment', text, user: { id: `v${++viewer}`, name: `观众${viewer}` } });
    }
    // 再塞一条会泄露答案的弹幕，验证它不计票
    await post('/api/manual', { kind: 'comment', text: '是不是西瓜啊', user: { id: 'leaker', name: '剧透哥' } });
  } else if (msg.action === 'result') {
    const v = msg.verdict ?? {};
    console.log(`${ts()} 📊 结果：${JSON.stringify(msg.counts)}（弃权 ${msg.abstain ?? 0}）→ ${v.key === 'unclear' ? '说法不一' : v.text}`);
  } else if (msg.action === 'reveal') {
    console.log(`${ts()} 🎉 揭晓：答案是「${msg.word}」`);
  } else if (msg.action === 'end') {
    console.log(`${ts()} ⏹ 结束`);
    await post('/api/config', { patch: { 'games.phases': REAL } });
    setTimeout(() => { ws.close(); process.exit(0); }, 300);
  }
});

ws.on('error', (e) => { console.error('连接失败：', e.message); process.exit(1); });
setTimeout(() => { console.log(`${ts()} 超时`); process.exit(1); }, 60_000).unref();
