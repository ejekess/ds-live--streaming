/**
 * 猜词的「决策」环节：把模型的**结构化输出**校验、归一、兜底。
 *
 * 流程定死的地方就该用结构化输出——动作空间只有两个：继续问 / 猜。
 * 让模型自由发挥只会把"该干嘛"变成概率。
 *
 * 模型返回：
 *   { "action": "ask" }                     → 继续下一轮
 *   { "action": "guess", "guess": "鲸鱼" }  → 猜
 *   { "action": "guess", "guess": "鲸鱼", "reason": "海边+冰冰凉" }  → 可带理由（只用来说话）
 *
 * 程序负责：
 *   1. 校验形状（action 必须是 ask/guess，guess 必须是非空短词）
 *   2. 最后一轮**强制猜**——这是规则，不是建议
 *   3. 猜对猜错由程序比对，模型没有"结束游戏"的权力
 */

export const MAX_GUESS_LEN = 12;

/**
 * @param {unknown} raw 模型返回（可能是对象、或 JSON 字符串）
 * @param {{forced?: boolean, round?: number, rounds?: number}} opts
 * @returns {{action:'ask'|'guess', guess:string|null, reason:string, source:string}}
 */
export function normalizeDecision(raw, { forced = false } = {}) {
  let obj = raw;

  if (typeof raw === 'string') {
    const t = raw.trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(t.slice(start, end + 1));
      } catch {
        obj = null;
      }
    }
  }

  let action = obj?.action === 'guess' ? 'guess' : obj?.action === 'ask' ? 'ask' : null;
  let guess = typeof obj?.guess === 'string' ? obj.guess.trim() : '';
  const reason = typeof obj?.reason === 'string' ? obj.reason.trim().slice(0, 40) : '';

  // 没给合法 action：有猜测就当猜，没有就当继续问
  if (!action) action = guess ? 'guess' : 'ask';

  // 猜测太长或带标点，砍一下
  if (guess) {
    guess = guess.replace(/[「」『』"'“”‘’。，,！!？?\s]/g, '').slice(0, MAX_GUESS_LEN);
    if (!guess) action = 'ask';
  }

  // 最后一轮：必须猜。模型说要继续也不许
  if (forced && action === 'ask') {
    action = 'guess';
    guess = guess || ''; // 没有猜测就交给调用方兜底（直接揭晓）
  }

  return { action, guess: guess || null, reason, source: obj ? 'model' : 'fallback' };
}

/** 猜中了没有。忽略空白与常见标点，不做拼音/模糊匹配（宁可判错也别误判）。 */
export function isCorrectGuess(guess, word) {
  if (!guess || !word) return false;
  const norm = (s) => String(s).replace(/[\s\u3000「」『』"'“”‘’。，,！!？?]/g, '');
  return norm(guess) === norm(word);
}

/**
 * 拼一句"她的猜测"。台词由程序生成，模型只提供猜测和理由——
 * 这样语感可控，模型不会把台词写成说明书。
 */
export function guessLine({ guess, reason, category, round }) {
  const openers = ['我觉得', '我猜是', '嗯……', '应该是'];
  const pick = openers[(round ?? 0) % openers.length];
  if (!guess) return '我实在想不出来了，你们告诉我吧';
  if (reason) return `${pick}「${guess}」——${reason}`;
  return `${pick}「${guess}」`;
}
