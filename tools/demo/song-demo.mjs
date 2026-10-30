/**
 * 点歌端到端演示：不需要浏览器，用一个「假舞台」把整条链路跑一遍。
 *
 *   node tools/song-demo.mjs "晴天"
 *   node tools/song-demo.mjs            # 不指定 → 随机
 *
 * 它做三件事：
 *   1. 连上 /ws?role=stage，收到 audio 指令就打印，并按 duration 回 audio-done
 *      （真实浏览器里是 <audio> 播完触发 ended 事件）；
 *   2. 调 /api/manual 触发一次点歌（自动发券）；
 *   3. 把时间线打出来：受理 → 报幕 → 静音 1.5s → 播放 → 完成。
 *
 * 这样在没有 OBS、没有声卡的机器上也能验证队列/音频/对账是否正确。
 */
import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const song = process.argv[2] ?? '';
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?role=stage`);
const timers = new Set();

ws.on('open', async () => {
  console.log(`${ts()} 假舞台已连接`);
  const res = await fetch(`${BASE}/api/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'song', song, tier: 4, name: '演示观众' }),
  }).then((r) => r.json());
  console.log(`${ts()} 点歌请求：${JSON.stringify(res)}`);
  if (!res.ok) finish(1);
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === 'act' && msg.line) console.log(`${ts()} 🗣 她说：${msg.line}`);
  if (msg.type !== 'audio') return;

  if (msg.action === 'duck') {
    console.log(`${ts()} 🔊 音乐音量 → ${msg.gain}`);
    return;
  }
  if (msg.action === 'stop') {
    console.log(`${ts()} ⏹ 停止 ${msg.track}`);
    return;
  }

  const label = msg.track === 'music' ? '🎵 音乐' : '🗣 语音';
  console.log(`${ts()} ${label} 开始：${msg.src} (id=${msg.id})`);

  // 模拟播放：这里不等真实时长，统一 1.2 秒后回报，让演示快一点
  const isMusic = msg.track === "music";
  const t = setTimeout(() => {
    timers.delete(t);
    ws.send(JSON.stringify({ type: 'audio-done', id: msg.id, track: msg.track, reason: 'ended' }));
  }, 1200);
  timers.add(t);

  // 音乐播完就收工（语音不算）
  if (isMusic) {
    setTimeout(async () => {
      const st = await fetch(`${BASE}/api/state`).then((r) => r.json()).catch(() => null);
      console.log(`${ts()} 音乐结束，队列状态：${JSON.stringify(st?.state?.songs ?? null)}`);
      finish(0);
    }, 1800);
  }
});

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  for (const t of timers) clearTimeout(t);
  try { ws.close(); } catch {}
  process.exit(code);
}

// 最多跑 40 秒
setTimeout(() => {
  console.log(`${ts()} 超时结束`);
  finish(0);
}, 40_000).unref();

ws.on('error', (err) => {
  console.error('连接失败：', err.message);
  finish(1);
});
