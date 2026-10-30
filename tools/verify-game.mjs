/**
 * 猜词游戏自检：不联网、不开浏览器。
 *
 *   node tools/verify-game.mjs
 *
 * 覆盖：词库合规（提示不含禁用字）、选项生成、状态机时序、投票计票、提前结束。
 */
import { WORDS, bannedCharsOf, hintIsSafe, buildHints, buildOptions, pickWord } from '../src/games/words.mjs';
import { GuessGame, PHASE, parseChoice } from '../src/games/engine.mjs';

let pass = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  failures.push({ name, detail });
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ═══════════════════════════════════════════
// G1 词库合规：提示里绝不能出现词中的字
// ═══════════════════════════════════════════
{
  let bad = 0;
  for (const entry of WORDS) {
    const banned = bannedCharsOf(entry.word);
    const hints = buildHints(entry, { count: 3 });
    if (!hints.length) {
      bad++;
      failures.push({ name: `G1 ${entry.word} 凑不出提示`, detail: '' });
    }
    for (const h of hints) {
      if (!hintIsSafe(h, banned)) {
        bad++;
        failures.push({ name: `G1 提示含禁用字：${entry.word} → ${h}`, detail: `禁用 ${banned.join('')}` });
      }
    }
  }
  ok(bad === 0, 'G1 所有预写提示都不含禁用字', `有 ${bad} 条不合规`);
  ok(WORDS.length >= 20, 'G1 词库至少 20 条', `实际 ${WORDS.length}`);
  eq(new Set(WORDS.map((w) => w.word)).size, WORDS.length, 'G1 词库无重复');
}

// ═══════════════════════════════════════════
// G2 提示过滤：坏提示会被剔除
// ═══════════════════════════════════════════
{
  const entry = { word: '西瓜', category: '水果', hint: '夏天吃西瓜' };
  const hints = buildHints(entry, { count: 3 });
  const banned = bannedCharsOf('西瓜');
  ok(hints.every((h) => hintIsSafe(h, banned)), 'G2 含禁用字的提示被剔除');
  ok(!hints.includes('夏天吃西瓜'), 'G2 那条含禁用字的提示确实没进来');
  eq(hints.length, 3, 'G2 仍然凑够 3 条');
}

// ═══════════════════════════════════════════
// G3 选项生成
// ═══════════════════════════════════════════
{
  for (const entry of WORDS.slice(0, 8)) {
    const opts = buildOptions(entry, { random: () => 0.42 });
    eq(opts.length, 4, `G3 ${entry.word} 出 4 个选项`);
    eq(opts.filter((o) => o.correct).length, 1, `G3 ${entry.word} 恰好一个正确`);
    eq(new Set(opts.map((o) => o.text)).size, 4, `G3 ${entry.word} 选项不重复`);
    ok(opts.every((o) => Array.from(o.text).length === Array.from(entry.word).length), `G3 ${entry.word} 字数一致`);
    eq(opts.map((o) => o.key), ['A', 'B', 'C', 'D'], `G3 ${entry.word} 键位固定`);
  }
}

// ═══════════════════════════════════════════
// G4 状态机时序
// ═══════════════════════════════════════════
const CFG = { introMs: 1000, hintGapMs: 1000, optionsMs: 2000, revealMs: 1000 };
function makeGame() {
  let t = 0;
  const entry = WORDS.find((w) => w.word === '西瓜');
  const options = buildOptions(entry, { random: () => 0.3 });
  const hints = buildHints(entry, { count: 3 });
  const g = new GuessGame({ entry, options, hints, cfg: CFG, clock: () => t });
  return { g, options, hints, setT: (v) => { t = v; }, getT: () => t };
}
{
  const { g, hints, setT } = makeGame();
  eq(g.phase, PHASE.IDLE, 'G4 初始 idle');
  const startEvents = g.start();
  eq(startEvents[0].type, 'intro', 'G4 start 发 intro');
  eq(g.phase, PHASE.INTRO, 'G4 进入 intro');

  setT(1000);
  let ev = g.tick();
  eq(ev.map((e) => e.type), ['hint'], 'G4 1s 后出第 1 条提示');
  eq(g.phase, PHASE.HINTING, 'G4 进入 hinting');

  setT(2000); ev = g.tick();
  eq(ev.map((e) => e.type), ['hint'], 'G4 第 2 条提示');
  setT(3000); ev = g.tick();
  eq(ev.map((e) => e.type), ['hint'], 'G4 第 3 条提示');
  eq(g.snapshot(3000).hintIndex, hints.length, 'G4 提示已全部发出');

  setT(4000); ev = g.tick();
  eq(ev.map((e) => e.type), ['options'], 'G4 提示说完 → 进入选项');
  eq(ev[0].options.length, 4, 'G4 选项随事件下发');

  setT(6000); ev = g.tick();
  eq(ev.map((e) => e.type), ['reveal'], 'G4 选项时间到 → 揭晓');
  eq(g.phase, PHASE.REVEAL, 'G4 进入 reveal');

  setT(7000); ev = g.tick();
  eq(ev.map((e) => e.type), ['done'], 'G4 揭晓结束 → done');
  eq(g.phase, PHASE.DONE, 'G4 进入 done');
  ok(!g.active, 'G4 done 后不再 active');
}

// ═══════════════════════════════════════════
// G5 投票与计票
// ═══════════════════════════════════════════
{
  const { g, options, setT } = makeGame();
  g.start();
  setT(1000); g.tick();
  setT(2000); g.tick();
  setT(3000); g.tick();
  setT(4000); g.tick(); // options
  eq(g.phase, PHASE.OPTIONS, 'G5 已进入投票阶段');

  const correct = options.find((o) => o.correct);
  const wrong = options.find((o) => !o.correct);

  // 非投票阶段拒绝
  const early = makeGame();
  early.g.start();
  eq(early.g.vote({ viewerId: 'u0', name: 'A', text: 'A' }).accepted, false, 'G5 intro 阶段投票被拒');

  eq(g.vote({ viewerId: 'u1', name: '甲', text: correct.key }).accepted, true, 'G5 正确选项被接受');
  eq(g.vote({ viewerId: 'u1', name: '甲', text: wrong.key }).accepted, false, 'G5 同一个人第二票被拒');
  eq(g.vote({ viewerId: 'u2', name: '乙', text: String(options.indexOf(wrong) + 1) }).accepted, true, 'G5 数字选项也能解析');
  eq(g.vote({ viewerId: 'u3', name: '丙', text: '随便说点什么' }).accepted, false, 'G5 无法解析的弹幕不算票');

  setT(6000);
  const reveal = g.tick().find((e) => e.type === 'reveal');
  eq(reveal.correctCount, 1, 'G5 正确票数 1');
  eq(reveal.totalVotes, 2, 'G5 总票数 2');
  eq(reveal.firstCorrect, '甲', 'G5 记录了最快答对的人');
  eq(reveal.answer, options.find((o) => o.correct).text, 'G5 揭晓的是正确答案');
}

// ═══════════════════════════════════════════
// G6 解析与提前结束
// ═══════════════════════════════════════════
{
  const opts = [{ key: 'A', text: '甲', correct: true }, { key: 'B', text: '乙', correct: false }, { key: 'C', text: '丙', correct: false }, { key: 'D', text: '丁', correct: false }];
  eq(parseChoice('a', opts).key, 'A', 'G6 小写 a');
  eq(parseChoice(' 选B ', opts).key, 'B', 'G6 "选B"');
  eq(parseChoice('3', opts).key, 'C', 'G6 数字 3');
  eq(parseChoice('哈哈哈哈', opts), null, 'G6 无关内容返回 null');

  const { g, setT } = makeGame();
  g.start();
  setT(500);
  const ev = g.finish();
  eq(ev[0].type, 'done', 'G6 提前结束发 done');
  eq(ev[0].forced, true, 'G6 标记为强制结束');
}

// ═══════════════════════════════════════════
// G7 抽词避开最近
// ═══════════════════════════════════════════
{
  const first = pickWord({ random: () => 0 });
  const second = pickWord({ avoid: [first.word], random: () => 0 });
  ok(first.word !== second.word, 'G7 抽词避开最近出过的');
}

const total = pass + failures.length;
if (failures.length) {
  console.log(`✗ ${pass}/${total} 通过，${failures.length} 项失败\n`);
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail}`);
  process.exit(1);
}
console.log(`✓ ${pass}/${total} 项猜词自检全部通过`);
