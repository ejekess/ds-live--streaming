/**
 * 猜词游戏端到端演示：不用浏览器，用一个「假舞台」观察全过程。
 *
 *   node tools/game-demo.mjs           # 用快速时序（约 15 秒跑完一局）
 *   node tools/game-demo.mjs --real    # 用真实时序（约 95 秒）
 *
 * 它会：连舞台 → 手动开局 → 打印每个阶段 → 在选项阶段注入几条投票 → 打印揭晓结果。
 */
import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const real = process.argv.includes('--real');
const FAST = { introMs: 800, hintGapMs: 800, optionsMs: 5000, revealMs: 1200 };

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());
}

if (!real) {
  await post('/api/config', { patch: { 'games.phases': FAST } });
  console.log(`${ts()} 已切到快速时序`, JSON.stringify(FAST));
}

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?role=stage`);
let voted = 0;
const votedKeys = new Set();

ws.on('open', async () => {
  console.log(`${ts()} 假舞台已连接`);
  const r = await post('/api/manual', { kind: 'game' });
  console.log(`${ts()} 开局：${JSON.stringify(r)}`);
  if (!r.ok) process.exit(1);
});

ws.on('message', async (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type !== 'game') return;

  if (msg.action === 'intro') {
    console.log(`${ts()} 📋 开场：${msg.category} · ${msg.length} 个字（答案不给管控台看）`);
  } else if (msg.action === 'hint') {
    console.log(`${ts()} 💬 提示${msg.index + 1}：${msg.text}`);
  } else if (msg.action === 'options') {
    console.log(`${ts()} 🔤 选项：${msg.options.map((o) => `${o.key}.${o.text}`).join('  ')}`);
    // 注入三个观众投票（不知道答案，瞎选）
    for (const key of ['A', 'B', 'C']) {
      if (votedKeys.has(key)) continue;
      votedKeys.add(key);
      voted += 1;
      await post('/api/manual', { kind: 'comment', text: key, user: { id: `demo-${key}`, name: `观众${key}` } });
    }
    // 再让一个不投票的观众说句废话，验证不会误计
    await post('/api/manual', { kind: 'comment', text: '哈哈哈哈', user: { id: 'demo-x', name: '路人' } });
    console.log(`${ts()} 🗳 已注入 ${voted} 票 + 1 条干扰弹幕`);
  } else if (msg.action === 'reveal') {
    console.log(`${ts()} 🎉 揭晓：答案「${msg.answer}」，票数 ${JSON.stringify(msg.counts)}，${msg.correctCount} 人猜对${msg.firstCorrect ? `，最快是 ${msg.firstCorrect}` : ''}`);
  } else if (msg.action === 'end') {
    console.log(`${ts()} ⏹ 本局结束`);
    if (!real) await post('/api/config', { patch: { 'games.phases': { introMs: 4000, hintGapMs: 12000, optionsMs: 45000, revealMs: 8000 } } });
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 400);
  } else if (msg.action === 'vote') {
    console.log(`${ts()}   · ${msg.user} 投了 ${msg.key}`);
  }
});

ws.on('error', (err) => {
  console.error('连接失败：', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log(`${ts()} 超时退出`);
  process.exit(1);
}, real ? 150_000 : 40_000).unref();
