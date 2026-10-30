/**
 * 语音与点歌的离线自检：不联网、不开浏览器、不需要 RVC。
 *
 *   node tools/verify-audio.mjs
 *   node tools/verify-audio.mjs --with-tts    # 额外验证真实合成（约 2 秒）
 *
 * 对应 docs/设计-语音与点歌.md §16.1 的 A1–A10。
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { parseSongRequest } from '../src/interaction/songIntent.mjs';
import { checkSong, privilegesFor, routeSong, normalizeSongName } from '../src/songs/gate.mjs';
import { SongQueue, STATUS } from '../src/songs/queue.mjs';
import { Quota } from '../src/songs/quota.mjs';
import { reduce, initialState, modeOf } from '../src/audio/state.mjs';
import { createVoice } from '../src/voice/index.mjs';

const TMP = path.resolve('data/runtime/verify');
const ROOT = path.resolve('.');

let pass = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  failures.push({ name, detail });
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
async function throwsAsync(fn, name) {
  try {
    await fn();
    failures.push({ name, detail: '期望抛错但没有' });
  } catch {
    pass++;
  }
}

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

// ══════════════════════════════════════════════════
// A1 点歌意图：20 条固定样例
// ══════════════════════════════════════════════════
const REQUEST_CASES = [
  ['点歌 晴天', '晴天'],
  ['点歌：青花瓷', '青花瓷'],
  ['来一首 夜空中最亮的星', '夜空中最亮的星'],
  ['唱一首起风了', '起风了'],
  ['点一首稻香', '稻香'],
  ['来首晴天吧', '晴天'],
  ['主播点歌 晴天', '晴天'],
  ['点歌', null],           // 不带歌名 → 随机
  ['来一首', null],
  ['唱个歌吧', '歌'],        // 语义上是要唱歌，具体歌名交给随机/曲库，这里判成有请求即可
  ['点歌 晴天 ', '晴天'],
  ['点歌  稻香 ', '稻香'],
];
const NOT_REQUEST = [
  '你会唱歌吗？',
  '能不能唱首歌',
  '刚才那首好好听',
  '今天天气不错',
  '666',
  '',
  '唱歌好听吗',
  '点歌吗',
];

for (const [text, expect] of REQUEST_CASES) {
  const r = parseSongRequest(text);
  ok(r.isRequest === true, `A1 应触发：${text}`, `实际 ${JSON.stringify(r)}`);
  if (expect !== undefined) eq(r.song, expect, `A1 歌名：${text}`);
}
for (const text of NOT_REQUEST) {
  const r = parseSongRequest(text);
  ok(r.isRequest === false, `A1 不应触发：${JSON.stringify(text)}`, `实际 ${JSON.stringify(r)}`);
}

// ══════════════════════════════════════════════════
// A2 队列状态机
// ══════════════════════════════════════════════════
{
  const file = path.join(TMP, 'q1.json');
  const q = await SongQueue.open({ file, max: 5 });
  const user = { id: 'u1', name: '小明' };
  const r = await q.request({ song: '晴天', user, tier: 3, priority: 1 });
  eq(r.ok, true, 'A2 入队成功');
  eq(r.item.status, STATUS.QUEUED, 'A2 初始状态 queued');

  await q.startRendering(r.id);
  eq(q.find(r.id).status, STATUS.RENDERING, 'A2 queued → rendering');
  await q.markReady(r.id, { file: '/x.mp3', durationMs: 1000 });
  eq(q.find(r.id).status, STATUS.READY, 'A2 rendering → ready');
  await q.markAnnouncing(r.id);
  await q.markPlaying(r.id);
  await q.markDone(r.id);
  eq(q.find(r.id).status, STATUS.DONE, 'A2 正常走到 done');

  await throwsAsync(() => q.markPlaying(r.id), 'A2 非法：done → playing');
  await throwsAsync(() => q.markReady(r.id, { file: '/y.mp3' }), 'A2 非法：done → ready');
  const q2 = await SongQueue.open({ file: path.join(TMP, 'q2.json'), max: 5 });
  const r2 = await q2.request({ song: '稻香', user, tier: 3, priority: 1 });
  await throwsAsync(() => q2.markPlaying(r2.id), 'A2 非法：queued → playing');
}

// ══════════════════════════════════════════════════
// A3 崩溃恢复
// ══════════════════════════════════════════════════
{
  const file = path.join(TMP, 'q3.json');
  const now = Date.now();
  const raw = {
    version: 1,
    items: [
      { id: 'a', song: 'A', requestedBy: { id: 'u', name: 'U' }, requesters: [], tier: 3, priority: 1, status: 'rendering', retries: 0, createdAt: now },
      { id: 'b', song: 'B', requestedBy: { id: 'u', name: 'U' }, requesters: [], tier: 3, priority: 1, status: 'playing', retries: 0, createdAt: now, file: '/b.mp3' },
      { id: 'c', song: 'C', requestedBy: { id: 'u', name: 'U' }, requesters: [], tier: 3, priority: 1, status: 'announcing', retries: 0, createdAt: now, file: '/c.mp3' },
      { id: 'd', song: 'D', requestedBy: { id: 'u', name: 'U' }, requesters: [], tier: 3, priority: 1, status: 'rendering', retries: 2, createdAt: now },
    ],
  };
  await writeFile(file, JSON.stringify(raw), 'utf8');
  const q = await SongQueue.open({ file, max: 5 });
  eq(q.find('a').status, 'queued', 'A3 rendering → queued');
  eq(q.find('a').retries, 1, 'A3 rendering 重试次数 +1');
  eq(q.find('b').status, 'ready', 'A3 playing → ready（可重播）');
  eq(q.find('c').status, 'ready', 'A3 announcing → ready');
  eq(q.find('d').status, 'failed', 'A3 重试耗尽 → failed');
}

// ══════════════════════════════════════════════════
// A4 插队 / A5 去重 / A6 队列满
// ══════════════════════════════════════════════════
{
  const file = path.join(TMP, 'q4.json');
  const q = await SongQueue.open({ file, max: 3 });
  const u = (n) => ({ id: n, name: n });
  await q.request({ song: 'T3-a', user: u('a'), tier: 3, priority: 1 });
  await q.request({ song: 'T3-b', user: u('b'), tier: 3, priority: 1 });
  await q.request({ song: 'T5-x', user: u('x'), tier: 5, priority: 3 });
  const order = q.list().map((i) => i.song);
  eq(order[0], 'T5-x', 'A4 T5 排在最前');
  eq(order.slice(1), ['T3-a', 'T3-b'], 'A4 T3 之间保持先来后到');

  // 去重：同一首歌再点一次 → 合并
  const dup = await q.request({ song: 'T3-a', user: u('c'), tier: 3, priority: 1 });
  eq(dup.merged, true, 'A5 同曲合并');
  eq(q.list().find((i) => i.song === 'T3-a').requesters.length, 2, 'A5 合并后有两个请求人');

  // 队列满：max=3，当前已有 3 条 active
  const full = await q.request({ song: 'T3-c', user: u('c'), tier: 3, priority: 1 });
  eq(full.ok, false, 'A6 队列满被拒');
  eq(full.reason, 'queue_full', 'A6 拒绝原因 queue_full');
}

// ══════════════════════════════════════════════════
// A7 点歌券
// ══════════════════════════════════════════════════
{
  const file = path.join(TMP, 'quota.json');
  let now = 1_000_000;
  const q = await Quota.open({ file, ttlMs: 60_000, grantWindowMs: 10_000, dailyLimit: { 3: 2, 4: 8, 5: 0 }, clock: () => now });

  eq((await q.grant('u1', 2)).granted, false, 'A7 T2 不发券');
  const g1 = await q.grant('u1', 3);
  eq(g1.granted, true, 'A7 T3 发券');
  eq(g1.credits, 1, 'A7 券数 1');

  const g2 = await q.grant('u1', 3);
  eq(g2.granted, false, 'A7 10 秒内重复打赏不重复发券');

  now += 11_000;
  const g3 = await q.grant('u1', 3);
  eq(g3.credits, 2, 'A7 超过窗口再发一张');

  eq((await q.take('u1')).ok, true, 'A7 扣券成功');
  eq((await q.take('u1')).ok, true, 'A7 扣第二张成功');
  const third = await q.take('u1');
  eq(third.ok, false, 'A7 无券后拒绝');

  // 每日上限（tier3 = 2，已用 2）
  now += 11_000;
  await q.grant('u1', 3);
  const limited = await q.take('u1');
  eq(limited.ok, false, 'A7 达到每日上限');
  eq(limited.reason, 'daily_limit', 'A7 原因 daily_limit');

  // 过期
  now += 61_000;
  const afterExpire = await q.take('u1');
  eq(afterExpire.ok, false, 'A7 过期后不能再用');

  // T5 发两张
  const g5 = await q.grant('u5', 5);
  eq(g5.credits, 2, 'A7 T5 发两张');
}

// ══════════════════════════════════════════════════
// A8 门禁
// ══════════════════════════════════════════════════
{
  eq(checkSong('晴天').ok, true, 'A8 正常歌名通过');
  eq(checkSong('周杰伦 - 青花瓷').ok, true, 'A8 带歌手通过');
  eq(checkSong('').ok, false, 'A8 空歌名拒绝');
  eq(checkSong('a'.repeat(30)).reason, 'too_long', 'A8 超长拒绝');
  eq(checkSong('晴天<script>').reason, 'bad_chars', 'A8 非法字符拒绝');
  eq(checkSong('鸡你太美', { blacklist: ['鸡你太美'] }).reason, 'blacklist', 'A8 黑名单拒绝');
  eq(checkSong('只因你太美', { homophoneRules: [{ pattern: '只因你太美' }] }).reason, 'homophone', 'A8 谐音拒绝');
  eq(normalizeSongName(' 青 花 瓷！ '), '青花瓷', 'A8 归一化去空格标点');

  // 档位路由
  eq(routeSong({ inLibrary: true, tier: 1 }).action, 'play', 'A8 曲库有 → 直接播');
  eq(routeSong({ inLibrary: false, tier: 3 }).action, 'reject', 'A8 T3 曲库没有 → 拒绝');
  eq(routeSong({ inLibrary: false, tier: 4 }).action, 'render', 'A8 T4 曲库没有 → 渲染');
  eq(privilegesFor(2).canSong, false, 'A8 T2 无点歌权');
  eq(privilegesFor(5).priority > privilegesFor(4).priority, true, 'A8 T5 优先级更高');
}

// ══════════════════════════════════════════════════
// A9 语音：固定短语 + 缓存
// ══════════════════════════════════════════════════
{
  const cacheDir = path.join(TMP, 'voice-cache');
  await mkdir(cacheDir, { recursive: true });
  const clipsDir = path.resolve('D:/space/deepseek/qq-bridge/audio');
  const voice = await createVoice({
    enabled: true,
    python: 'python',
    pythonPath: path.resolve('data/pylibs'),
    clipsDir: existsSync(clipsDir) ? clipsDir : path.join(TMP, 'no-clips'),
    cacheDir,
    voice: 'zh-CN-XiaoyiNeural',
    pitch: '+12Hz',
    rate: '-20%',
  });

  const clip = await voice.speak('在呢在呢');
  eq(clip?.source, 'clip', 'A9 固定短语命中');

  // 预置缓存文件，验证"命中缓存不再合成"
  const text = '这是一条缓存测试';
  const key = createHash('sha1').update(`zh-CN-XiaoyiNeural|+12Hz|-20%|${text}`).digest('hex').slice(0, 16);
  await writeFile(path.join(cacheDir, `${key}.mp3`), Buffer.alloc(6000, 0));
  const cached = await voice.speak(text);
  eq(cached?.source, 'cache', 'A9 命中缓存');

  if (process.argv.includes('--with-tts')) {
    const real = await voice.speak('真的合成一句试试');
    eq(real?.source, 'tts', 'A9 真实合成成功');
    const again = await voice.speak('真的合成一句试试');
    eq(again?.source, 'cache', 'A9 合成后进缓存');
  }
}

// ══════════════════════════════════════════════════
// A10 音频状态机
// ══════════════════════════════════════════════════
{
  let s = initialState();
  const run = (action) => {
    const out = reduce(s, action);
    s = out.state;
    return out.emit;
  };

  const solo = { id: 'voice1', durationMs: 1000 };
  run({ type: 'playVoice', item: solo });
  eq(modeOf(s), 'speaking', 'A10 说话模式');

  // voice 抢占 voice
  const v2 = { id: 'voice2', durationMs: 1000 };
  const emits = run({ type: 'playVoice', item: v2 });
  eq(emits.some((e) => e.cmd === 'stopVoice' && e.id === 'voice1'), true, 'A10 新语音顶掉旧语音');
  eq(s.voice.id, 'voice2', 'A10 当前语音是新的');

  // 迟到的旧语音 done 不应影响新语音
  run({ type: 'voiceDone', id: 'voice1' });
  eq(s.voice.id, 'voice2', 'A10 迟到的 voiceDone 被忽略');

  // music 播放
  const music = { id: 'm1', durationMs: 5000 };
  const mEmits = run({ type: 'playMusic', item: music });
  eq(mEmits.some((e) => e.cmd === 'playMusic'), true, 'A10 音乐开始播放');
  eq(modeOf(s), 'singing', 'A10 唱歌模式');

  // 歌声中说话 → duck，不打断
  const duckEmits = run({ type: 'playVoice', item: { id: 'voice3', durationMs: 800 } });
  eq(duckEmits.some((e) => e.cmd === 'duck' && e.gain < 1), true, 'A10 说话时音乐被压低');
  eq(s.music.id, 'm1', 'A10 音乐没有被中断');

  // 说完恢复音量
  const unduck = run({ type: 'voiceDone', id: 'voice3' });
  eq(unduck.some((e) => e.cmd === 'duck' && e.gain === 1), true, 'A10 说完恢复音量');

  // music 占用时不能再开一首
  const busy = run({ type: 'playMusic', item: { id: 'm2', durationMs: 5000 } });
  eq(busy.some((e) => e.cmd === 'busy'), true, 'A10 音乐占用时拒绝第二首');
  eq(s.music.id, 'm1', 'A10 仍是原来那首');

  // 播完
  const ended = run({ type: 'musicDone', id: 'm1' });
  eq(ended.some((e) => e.cmd === 'musicEnded' && e.item.id === 'm1'), true, 'A10 播完上报 musicEnded');
  eq(modeOf(s), 'silent', 'A10 回到静默');
}

// ══════════════════════════════════════════════════
const total = pass + failures.length;
if (failures.length) {
  console.log(`✗ ${pass}/${total} 通过，${failures.length} 项失败\n`);
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail}`);
  process.exit(1);
}
console.log(`✓ ${pass}/${total} 项音频/点歌自检全部通过`);
