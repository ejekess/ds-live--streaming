/**
 * 弹幕挑选器：决定「回哪一条」。
 *
 * 直播间一秒钟能进十条弹幕，全回等于没回——观众只会看到一只语无伦次的鲸鱼。
 * 所以这里做的是**慢挑选**：先攒一小段时间，再按分数挑一条最值得回的。
 *
 * 评分原则，按重要性排序：
 *   1. 有明确诉求的（问句、点名）优先 —— 这类不回最伤体验；
 *   2. 有信息量的（长度适中、带实词）其次；
 *   3. 粉丝团/老观众略微加权；
 *   4. 刷屏、广告、纯表情、超长、疑似钓鱼一律扣到出局；
 *   5. 同一个人短时间内被回过就不再选他，避免变成一对一私聊。
 */
import { clean, visibleLength, isEmojiOnly, isNoise, looksLikeInjection } from '../text.mjs';

const QUESTION = /[?？]|吗|呢|怎么|为什么|能不能|可不可以|有没有|什么|谁|哪儿|多少|求|教我/;
const TOPIC = /(鲸|鱼|海|直播|主播|今天|喜欢|名字|唱歌|跳舞|可爱|颜色|吃|几点|关注|礼物)/;

/** 默认忽略的话术（广告/拉私域），可在配置里追加。 */
const DEFAULT_IGNORE = [/加\s*(微|v|V|微信)/, /代刷/, /卖号/, /返利/, /兼职/, /私聊/, /互关/];

export class CommentSelector {
  #opts;
  #buffer = [];
  #lastReplyAt = 0;
  #replyStamps = [];
  #userReplyAt = new Map();
  #seenText = new Map();
  #stats = { seen: 0, rejected: 0, picked: 0 };

  constructor(opts = {}) {
    this.#opts = {
      minScore: opts.minScore ?? 7,
      maxLength: opts.ignore?.maxLength ?? 60,
      ignorePatterns: [...DEFAULT_IGNORE, ...((opts.ignore?.patterns ?? []).map((p) => new RegExp(p)))],
      minIntervalMs: opts.minIntervalMs ?? 7000,
      maxPerMinute: opts.maxPerMinute ?? 5,
      bufferTtlMs: opts.bufferTtlMs ?? 9000,
    };
  }

  setOptions(opts = {}) {
    if (typeof opts.minScore === 'number') this.#opts.minScore = opts.minScore;
    if (typeof opts.minIntervalMs === 'number') this.#opts.minIntervalMs = opts.minIntervalMs;
    if (typeof opts.maxPerMinute === 'number') this.#opts.maxPerMinute = opts.maxPerMinute;
  }

  get stats() {
    return { ...this.#stats, buffered: this.#buffer.length };
  }

  /** 收一条弹幕进候选池。 */
  offer(ev) {
    this.#stats.seen++;
    const text = clean(ev.text);
    const now = ev.ts || Date.now();

    const verdict = this.#screen(text, ev, now);
    if (!verdict.ok) {
      this.#stats.rejected++;
      return { accepted: false, reason: verdict.reason };
    }

    this.#buffer.push({ ev, text, score: verdict.score, reasons: verdict.reasons, at: now });
    // 池子不要无限长
    if (this.#buffer.length > 120) this.#buffer.splice(0, this.#buffer.length - 120);
    return { accepted: true, score: verdict.score };
  }

  /** 硬性过滤。返回 ok=false 的直接不进池。 */
  #screen(text, ev, now) {
    if (!text) return { ok: false, reason: '空' };
    const len = visibleLength(text);
    if (len < 2) return { ok: false, reason: '太短' };
    if (len > this.#opts.maxLength) return { ok: false, reason: '超长' };
    if (isNoise(text) || isEmojiOnly(text)) return { ok: false, reason: '无实义' };
    if (this.#opts.ignorePatterns.some((re) => re.test(text))) return { ok: false, reason: '命中忽略词' };

    const repeats = (this.#seenText.get(text) ?? 0) + 1;
    this.#seenText.set(text, repeats);
    if (repeats >= 3) return { ok: false, reason: '同一句刷屏' };

    const lastSameUser = this.#userReplyAt.get(ev.user.id) ?? 0;
    if (now - lastSameUser < 45_000) return { ok: false, reason: '这个人的话刚回过' };

    const reasons = [];
    let score = 0;
    if (QUESTION.test(text)) {
      score += 4;
      reasons.push('问句+4');
    }
    if (TOPIC.test(text)) {
      score += 3;
      reasons.push('有话题+3');
    }
    if (len >= 4 && len <= 24) {
      score += 2;
      reasons.push('长度合适+2');
    } else if (len > 40) {
      score -= 4;
      reasons.push('偏长-4');
    }
    if (ev.user.isFan) {
      score += 2;
      reasons.push('粉丝团+2');
    }
    if (looksLikeInjection(text)) {
      score -= 6;
      reasons.push('疑似钓鱼-6');
    }
    score += Math.random() * 1.5;

    return { ok: true, score, reasons };
  }

  /** 限流：两次搭话的间隔、每分钟条数。返回 null 表示现在不该说话。 */
  #throttled(now) {
    if (now - this.#lastReplyAt < this.#opts.minIntervalMs) return '间隔未到';
    this.#replyStamps = this.#replyStamps.filter((t) => now - t < 60_000);
    if (this.#replyStamps.length >= this.#opts.maxPerMinute) return '每分钟上限';
    return null;
  }

  /**
   * 挑一条。
   * @returns {{ev:object, text:string, score:number, reasons:string[]}|null}
   */
  pick(now = Date.now()) {
    // 过期的候选直接扔掉
    this.#buffer = this.#buffer.filter((c) => now - c.at < this.#opts.bufferTtlMs);
    if (!this.#buffer.length) return null;

    const reason = this.#throttled(now);
    if (reason) return { blocked: reason };

    const ranked = [...this.#buffer].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best.score < this.#opts.minScore) return { blocked: `最高分 ${best.score.toFixed(1)} 未达阈值` };

    // 选中即消费掉这条和它的重复
    this.#buffer = this.#buffer.filter((c) => c !== best);
    this.#lastReplyAt = now;
    this.#replyStamps.push(now);
    this.#userReplyAt.set(best.ev.user.id, now);
    this.#stats.picked++;
    return { ev: best.ev, text: best.text, score: best.score, reasons: best.reasons };
  }

  clear() {
    this.#buffer.length = 0;
  }

  /** 定期清理「刷屏计数」，别让一句正常的话永久被拉黑。 */
  decay() {
    const now = Date.now();
    for (const [key, count] of this.#seenText) {
      if (count <= 1) this.#seenText.delete(key);
      else this.#seenText.set(key, count - 1);
    }
    for (const [uid, at] of this.#userReplyAt) {
      if (now - at > 120_000) this.#userReplyAt.delete(uid);
    }
  }
}
