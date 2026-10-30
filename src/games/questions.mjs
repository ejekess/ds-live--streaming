/**
 * 联想题题库。
 *
 * 从 Phantom Ink《幽灵笔迹》学来的关键一点：**题目要问联想，不要问事实**。
 *
 * 事实题的毛病（我第一版就是这样）：
 *   - 答案唯一 → 观众投票没有分歧，不好看；
 *   - 信息量大 → 两三个问题就把答案锁死了；
 *   - 答错就是"错"，没有解释空间。
 *
 * 联想题（"如果它是动物，会是哪种"）：
 *   - 答案天生主观 → 分歧是常态，"大家说的不一样"本身就是内容；
 *   - 每轮只给一点点模糊线索 → 五轮下来还是能吵起来；
 *   - 没有标准答案 → 观众不会觉得自己"答错"。
 *
 * 每题 4 个选项（联想空间比三选一大），另设 `0` 为弃权。
 */

/** 弃权键。 */
export const ABSTAIN = 'abstain';

/**
 * @type {string[][]} [id, 题干, 四个选项]
 */
const RAW = [
  ['animal', '如果它是动物，会是哪种', ['猫', '狗', '鸟', '鱼']],
  ['weather', '如果它是天气，会是哪种', ['晴天', '下雨', '下雪', '起风']],
  ['color', '如果它有颜色，更接近哪种', ['红色', '蓝色', '绿色', '白色']],
  ['season', '它让你想到哪个季节', ['春天', '夏天', '秋天', '冬天']],
  ['character', '如果它是性格，会是哪种', ['安静', '活泼', '暴躁', '温柔']],
  ['time', '它更像一天里的哪个时段', ['清晨', '中午', '傍晚', '深夜']],
  ['age', '如果它是人，大概多大', ['小孩', '青年', '中年', '老人']],
  ['touch', '摸上去更像什么感觉', ['硬邦邦', '软乎乎', '冰冰凉', '热乎乎']],
  ['voice', '如果它会说话，声音是', ['尖细', '低沉', '清脆', '沙哑']],
  ['music', '它更像哪种音乐', ['摇滚', '古典', '民谣', '电子']],
  ['taste', '如果它是味道，是哪一种', ['甜', '咸', '酸', '辣']],
  ['place', '它让你想到什么地方', ['家里', '街上', '山里', '海边']],
  ['emotion', '如果它是情绪，会是哪种', ['开心', '无聊', '紧张', '安心']],
  ['action', '如果它是一个动作', ['跑', '躺', '转', '停']],
  ['price', '它一般是贵还是便宜', ['很便宜', '一般', '有点贵', '非常贵']],
  ['crowd', '它更常在人多还是人少的地方', ['人多的闹市', '人少的角落', '家里', '户外']],
  ['speed', '它的节奏更像', ['很快', '不快不慢', '很慢', '完全静止']],
  ['story', '如果要给它编个身份', ['工具', '伙伴', '装饰', '麻烦']],
];

function toQuestion([id, text, options]) {
  return {
    id,
    text,
    options: options.map((t, i) => ({ key: String(i + 1), text: t })),
  };
}

/** 全部联想题（每题 4 个选项）。 */
export const QUESTIONS = RAW.map(toQuestion);

/** 兼容旧接口：联想题不分通用/分类，所有词共用。 */
export const GENERAL_QUESTIONS = QUESTIONS;
export const CATEGORY_QUESTIONS = {};

export function questionsFor() {
  return QUESTIONS;
}

/**
 * 抽 n 个没问过的问题给观众选。
 * @param {string[]} asked 已经问过的题目文本
 */
export function pickQuestions(asked = [], n = 3, random = Math.random) {
  const used = new Set(asked);
  let pool = QUESTIONS.filter((q) => !used.has(q.text));
  if (pool.length < n) pool = QUESTIONS;
  const bag = [...pool];
  const out = [];
  while (out.length < n && bag.length) {
    out.push(bag.splice(Math.floor(random() * bag.length), 1)[0]);
  }
  return out;
}

/**
 * 把弹幕解析成选项键（'1'..'4'）或 ABSTAIN；看不懂返回 null。
 * 只认极小词表 —— 不在表里的内容没有落点，这是防泄露的核心。
 */
export function parseAnswer(text, options = []) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[\s\u3000，。！？,.!?~～]/g, '');
  if (!t) return null;

  if (/^(0|不确定|不知道|不清楚|不好说|弃权|跳过)$/.test(t)) return ABSTAIN;

  const max = options.length;
  if (/^\d$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= max) return t;
  }

  const exact = options.find((o) => o.text.replace(/[\s\u3000]/g, '').toLowerCase() === t);
  if (exact) return exact.key;

  if (t.length <= 6) {
    const hit = options.find((o) => t.includes(o.text.replace(/[\s\u3000]/g, '').toLowerCase()));
    if (hit) return hit.key;
  }

  return null;
}

/** 选题：只认 1/2/3。 */
export function parseQuestionPick(text) {
  const t = String(text ?? '').trim().replace(/[\s\u3000]/g, '');
  const m = t.match(/^(?:第)?([1-3一二三])(?:个|号|选项)?$/);
  if (!m) return null;
  return { 1: 1, 2: 2, 3: 3, 一: 1, 二: 2, 三: 3 }[m[1]] ?? null;
}

/**
 * 取名次最高的选项（**相对多数**，不设 60% 门槛）。
 *
 * 为什么改：联想题天然分散，"猫 40% / 狗 35%" 是正常且有趣的，
 * 用 60% 阈值会把大部分轮次判成"说不清"，反而丢信息。平票才算 unclear。
 */
export function verdictOf(counts, options) {
  const keys = options.map((o) => o.key);
  const total = keys.reduce((sum, k) => sum + (counts[k] ?? 0), 0);
  if (!total) return { key: 'unclear', text: '', total: 0, share: 0 };

  let best = 0;
  for (const k of keys) best = Math.max(best, counts[k] ?? 0);
  const tied = keys.filter((k) => (counts[k] ?? 0) === best);
  if (best === 0 || tied.length > 1) return { key: 'unclear', text: '', total, share: 0 };

  const opt = options.find((o) => o.key === tied[0]);
  return { key: tied[0], text: opt?.text ?? '', total, share: best / total };
}
