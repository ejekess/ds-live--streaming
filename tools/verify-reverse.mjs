/**
 * 反向猜词自检（联想题库版）。
 *
 *   node tools/verify-reverse.mjs
 */
import { ReverseGame, PHASE } from '../src/games/reverse.mjs';
import { normalizeDecision, isCorrectGuess } from '../src/games/decide.mjs';
import {
  QUESTIONS,
  questionsFor,
  pickQuestions,
  parseAnswer,
  parseQuestionPick,
  verdictOf,
  ABSTAIN,
} from '../src/games/questions.mjs';
import { WORDS, CATEGORIES, pickWord, buildHints, buildOptions } from '../src/games/words.mjs';

let pass = 0;
const failures = [];
const ok = (c, n, d) => (c ? pass++ : failures.push({ name: n, detail: d }));
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

// ══════════ C1 词库 ══════════
{
  eq(new Set(WORDS.map((w) => w.word)).size, WORDS.length, 'C1 词库无重复');
  ok(WORDS.length >= 40, 'C1 词库至少 40 条', `实际 ${WORDS.length}`);
  ok(WORDS.every((w) => CATEGORIES.includes(w.category)), 'C1 类别合法');
  ok(WORDS.every((w) => typeof w.hint === 'string' && w.hint.length > 0), 'C1 每词都有专属提示');
  const byCat = {};
  for (const w of WORDS) byCat[w.category] = (byCat[w.category] ?? 0) + 1;
  ok(CATEGORIES.every((c) => (byCat[c] ?? 0) >= 2), 'C1 每类至少 2 个词', JSON.stringify(byCat));
}

// ══════════ C2 联想题库 ══════════
{
  ok(QUESTIONS.length >= 15, 'C2 题库至少 15 题', `实际 ${QUESTIONS.length}`);
  ok(QUESTIONS.every((q) => q.options.length === 4), 'C2 每题恰好 4 个选项');
  ok(QUESTIONS.every((q) => new Set(q.options.map((o) => o.text)).size === 4), 'C2 同一题选项不重复');
  ok(QUESTIONS.every((q) => q.options.every((o) => o.text.length > 0)), 'C2 选项非空');
  eq(new Set(QUESTIONS.map((q) => q.id)).size, QUESTIONS.length, 'C2 题 id 不重复');

  // 联想题不应该出现"是/不是"这种事实型选项
  const factish = QUESTIONS.filter((q) => q.options.some((o) => /^(是|不是|对|错|有|没有)$/.test(o.text)));
  eq(factish.length, 0, 'C2 题库里没有纯是非选项（应全是联想词）');
}

// ══════════ C3 抽题 ══════════
{
  const first = pickQuestions([], 3, () => 0.13);
  eq(first.length, 3, 'C3 抽满 3 题');
  eq(new Set(first.map((q) => q.text)).size, 3, 'C3 抽到的不重复');
  const second = pickQuestions(first.map((q) => q.text), 3, () => 0.13);
  ok(second.every((q) => !first.some((f) => f.text === q.text)), 'C3 避开问过的');
  eq(questionsFor().length, QUESTIONS.length, 'C3 questionsFor 返回全部');
}

// ══════════ C4 提示与选项生成 ══════════
{
  for (const entry of WORDS.slice(0, 12)) {
    const hints = buildHints(entry, { count: 3 });
    eq(hints.length, 3, `C4 ${entry.word} 凑够 3 条提示`);
    ok(hints.every((h) => !Array.from(entry.word).some((ch) => h.replace(/\s/g, '').includes(ch))), `C4 ${entry.word} 提示不含禁用字`);

    const opts = buildOptions(entry, { random: () => 0.37 });
    eq(opts.length, 4, `C4 ${entry.word} 四个选项`);
    eq(opts.filter((o) => o.correct).length, 1, `C4 ${entry.word} 一个正确`);
    eq(new Set(opts.map((o) => o.text)).size, 4, `C4 ${entry.word} 选项不重复`);
    ok(opts.every((o) => Array.from(o.text).length === Array.from(entry.word).length), `C4 ${entry.word} 字数一致`);
  }
}

// ══════════ C5 回答解析（4 选项 + 弃权 0） ══════════
{
  const opts = [
    { key: '1', text: '猫' },
    { key: '2', text: '狗' },
    { key: '3', text: '鸟' },
    { key: '4', text: '鱼' },
  ];
  eq(parseAnswer('1', opts), '1', 'C5 数字键 1');
  eq(parseAnswer('4', opts), '4', 'C5 数字键 4（四选项也认）');
  eq(parseAnswer('狗', opts), '2', 'C5 选项文字');
  eq(parseAnswer('我觉得是鱼', opts), '4', 'C5 短句包含选项');
  eq(parseAnswer('0', opts), ABSTAIN, 'C5 数字 0 弃权');
  eq(parseAnswer('不确定', opts), ABSTAIN, 'C5 不确定 → 弃权');
  eq(parseAnswer('沙发', opts), null, 'C5 直接说答案不算回答');
  eq(parseAnswer('哈哈哈哈', opts), null, 'C5 无关内容不算');
  eq(parseAnswer('5', opts), null, 'C5 超出选项范围不算');
}

// ══════════ C6 相对多数 ══════════
{
  const opts = [
    { key: '1', text: '猫' },
    { key: '2', text: '狗' },
    { key: '3', text: '鸟' },
    { key: '4', text: '鱼' },
  ];
  eq(verdictOf({ 1: 4, 2: 3, 3: 1, 4: 0 }, opts).key, '1', 'C6 相对多数即胜出（不需要 60%）');
  eq(verdictOf({ 1: 3, 2: 3, 3: 1, 4: 0 }, opts).key, 'unclear', 'C6 平票 → 说不清');
  eq(verdictOf({ 1: 0, 2: 0, 3: 0, 4: 0 }, opts).key, 'unclear', 'C6 没票 → 说不清');
  eq(verdictOf({ 1: 1, 2: 0, 3: 0, 4: 0 }, opts).share, 1, 'C6 一票独大 → 100%');
}

// ══════════ C7 完整一局（4 选项） ══════════
{
  let t = 0;
  const cfg = { startMs: 0, pickMs: 100, askMs: 100, answerMs: 100, revealMs: 100, rounds: 2 };
  const g = new ReverseGame({ word: '西瓜', category: '水果', cfg, clock: () => t, random: () => 0.2 });

  const start = g.start();
  eq(start[0].type, 'pick', 'C7 开局选题');
  eq(start[0].options.length, 3, 'C7 三个候选问题');
  eq(start[0].word, undefined, 'C7 事件里没有 word 字段（模型无权拿）');
  eq(start[0].displayWord, '西瓜', 'C7 但带 displayWord 供舞台显示（观众是幽灵）');
  eq(g.snapshot().word, null, 'C7 快照在揭晓前不给答案');

  t = 100;
  const ask = g.tick().find((e) => e.type === 'ask');
  ok(ask?.question, 'C7 提问带题干');

  t = 200;
  const ans = g.tick().find((e) => e.type === 'answer');
  eq(ans.options.length, 4, 'C7 回答是四个联想选项');
  ok(/如果|更像|想到|会/.test(ans.question), 'C7 问的是联想题', ans.question);

  eq(g.vote({ viewerId: 'u1', text: '1' }).accepted, true, 'C7 投 1');
  eq(g.vote({ viewerId: 'u2', text: '1' }).accepted, true, 'C7 再投 1');
  eq(g.vote({ viewerId: 'u3', text: '2' }).accepted, true, 'C7 投 2');
  eq(g.vote({ viewerId: 'u4', text: '0' }).accepted, true, 'C7 弃权被接受');
  eq(g.vote({ viewerId: 'u1', text: '3' }).accepted, false, 'C7 改票无效');
  eq(g.vote({ viewerId: 'u5', text: '西瓜' }).accepted, false, 'C7 说答案不算');

  t = 300;
  const res = g.tick().find((e) => e.type === 'result');
  eq(res.counts['1'], 2, 'C7 选项 1 两票');
  eq(res.abstain, 1, 'C7 弃权一票');
  eq(res.verdict.key, '1', 'C7 相对多数判为 1');

  eq(g.snapshot().votes, 4, 'C7 累计票数是整局口径（4 票）');

  const pick2 = g.tick().find((e) => e.type === 'pick');
  ok(!pick2 || pick2.round === 2, 'C7 进入第 2 轮');
}

// ══════════ C8 决策：猜对提前结束 ══════════
{
  let t = 0;
  const cfg = { startMs: 0, pickMs: 50, askMs: 50, answerMs: 50, revealMs: 50, rounds: 5, decideTimeoutMs: 999999, maxGuesses: 3 };
  const g = new ReverseGame({ word: '地铁', category: '交通', cfg, clock: () => t, random: () => 0 });
  g.start();
  let decideEvent = null;
  for (let i = 0; i < 6 && !decideEvent; i++) {
    t += 60;
    for (const e of g.tick()) if (e.type === 'decide') decideEvent = e;
  }
  ok(Boolean(decideEvent), 'C8 一轮结束后进入 decide（停下来等模型）');
  eq(decideEvent?.forced, false, 'C8 第 1 轮不强制猜');
  eq(g.phase, PHASE.DECIDE, 'C8 状态机停在 decide');
  eq(g.snapshot().word, null, 'C8 decide 阶段仍然不暴露答案');

  // 模型猜对了 → 提前结束（第 1 轮就结束，远没到 rounds:5）
  const ev = g.applyDecision({ action: 'guess', guess: '地铁' }, t);
  const reveal = ev.find((e) => e.type === 'reveal');
  ok(Boolean(reveal), 'C8 猜对 → 直接揭晓');
  eq(reveal?.solved, true, 'C8 标记 solved');
  eq(reveal?.rounds, 1, 'C8 第 1 轮就结束了');
  eq(g.phase, PHASE.REVEAL, 'C8 进入 reveal');
  eq(g.snapshot().word, '地铁', 'C8 揭晓后快照才带答案');

  t += 60;
  const done = g.tick().find((e) => e.type === 'done');
  ok(Boolean(done), 'C8 之后正常 done');
  eq(g.phase, PHASE.DONE, 'C8 最终 done');
}

// ══════════ C9 决策：猜错继续 ══════════
{
  let t = 0;
  const cfg = { startMs: 0, pickMs: 50, askMs: 50, answerMs: 50, revealMs: 50, rounds: 3, decideTimeoutMs: 999999, maxGuesses: 3 };
  const g = new ReverseGame({ word: '熊猫', category: '动物', cfg, clock: () => t, random: () => 0 });
  g.start();
  for (let i = 0; i < 6; i++) { t += 60; g.tick(); }
  eq(g.phase, PHASE.DECIDE, 'C9 进入 decide');

  const ev = g.applyDecision({ action: 'guess', guess: '北极熊' }, t);
  ok(ev.some((e) => e.type === 'wrongGuess'), 'C9 猜错会发出 wrongGuess');
  ok(ev.some((e) => e.type === 'pick'), 'C9 猜错后继续下一轮');
  eq(g.phase, PHASE.PICK, 'C9 回到 pick');
  eq(g.snapshot().guesses, ['北极熊'], 'C9 记下了这次猜错');
}

// ══════════ C10 强制猜 + 超时降级 ══════════
{
  // 最后一轮：模型说要继续，程序也必须让它猜
  let t = 0;
  const cfg = { startMs: 0, pickMs: 50, askMs: 50, answerMs: 50, revealMs: 50, rounds: 1, decideTimeoutMs: 999999, maxGuesses: 3 };
  const g = new ReverseGame({ word: '苹果', category: '水果', cfg, clock: () => t, random: () => 0 });
  g.start();
  let dec = null;
  for (let i = 0; i < 6 && !dec; i++) { t += 60; for (const e of g.tick()) if (e.type === 'decide') dec = e; }
  ok(Boolean(dec), 'C10 进入 decide');
  eq(dec?.forced, true, 'C10 最后一轮标记 forced');
  const ev = g.applyDecision({ action: 'ask' }, t);
  ok(ev.some((e) => e.type === 'reveal'), 'C10 最后一轮不许再问，直接揭晓');

  // 超时降级：模型不回话，到点自己往下走，不卡死
  let t2 = 0;
  const cfg2 = { pickMs: 50, askMs: 50, answerMs: 50, revealMs: 50, rounds: 3, decideTimeoutMs: 100, maxGuesses: 3 };
  const g2 = new ReverseGame({ word: '气球', category: '物品', cfg: cfg2, clock: () => t2, random: () => 0 });
  g2.start();
  for (let i = 0; i < 3; i++) { t2 += 60; g2.tick(); }
  eq(g2.phase, PHASE.DECIDE, 'C10b 三轮推进后进入 decide');
  t2 += 200;
  const ev2 = g2.tick();
  ok(ev2.length > 0, 'C10b 超时后自动推进');
  ok(g2.phase !== PHASE.DECIDE, 'C10b 超时后离开 decide', g2.phase);

  const g3 = new ReverseGame({ word: '气球', category: '物品', cfg: { startMs: 0, pickMs: 9e9, askMs: 1, answerMs: 1, revealMs: 1, rounds: 3 } });
  g3.start();
  eq(g3.finish()[0].forced, true, 'C10c 强制结束');
}

// ══════════ C11 决策归一化 ══════════
{
  eq(normalizeDecision({ action: 'guess', guess: '鲸鱼' }).action, 'guess', 'C11 正常 guess');
  eq(normalizeDecision({ action: 'ask' }).action, 'ask', 'C11 正常 ask');
  eq(normalizeDecision({ action: 'guess', guess: '鲸鱼' }, { forced: true }).guess, '鲸鱼', 'C11 强制模式保留猜测');
  eq(normalizeDecision({ action: 'ask' }, { forced: true }).action, 'guess', 'C11 强制模式下 ask 被改成 guess');
  eq(normalizeDecision('{"action":"guess","guess":"西瓜"}').guess, '西瓜', 'C11 能吃 JSON 字符串');
  eq(normalizeDecision('我觉得是西瓜').action, 'ask', 'C11 说人话/乱回答 → 当继续问');
  eq(normalizeDecision(null).action, 'ask', 'C11 null → 继续问');
  eq(normalizeDecision({ action: 'guess', guess: '「鲸鱼」。' }).guess, '鲸鱼', 'C11 去掉标点');
  ok(isCorrectGuess(' 西瓜 ', '西瓜'), 'C11 忽略空白');
  ok(!isCorrectGuess('西瓜子', '西瓜'), 'C11 不做模糊匹配');
}

// ══════════ C9 抽词 ══════════
{
  const a = pickWord({ random: () => 0 });
  const b = pickWord({ avoid: [a.word], random: () => 0 });
  ok(a.word !== b.word, 'C9 避开最近用过的词');
  eq(pickWord({ category: '动物', random: () => 0 }).category, '动物', 'C9 能按类别抽词');
}

const total = pass + failures.length;
if (failures.length) {
  console.log(`✗ ${pass}/${total} 通过，${failures.length} 项失败\n`);
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail}`);
  process.exit(1);
}
console.log(`✓ ${pass}/${total} 项反向猜词自检全部通过`);
