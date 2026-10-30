/**
 * 猜词游戏的状态机（纯逻辑，不碰定时器、不碰网络）。
 *
 * 阶段：
 *   idle → intro(开场) → hinting(逐条描述) → options(选项投票) → reveal(揭晓) → done
 *
 * 为什么拆成纯状态机：这里的坑全是"时序"和"计票"，最容易写错也最该能单测。
 * 真正的 setInterval 和播报在 index.mjs 里。
 */

export const PHASE = {
  IDLE: 'idle',
  INTRO: 'intro',
  HINTING: 'hinting',
  OPTIONS: 'options',
  REVEAL: 'reveal',
  DONE: 'done',
};

/** 把观众发的字解析成选项；看不懂返回 null。 */
export function parseChoice(text, options) {
  const t = String(text ?? '').toUpperCase().replace(/[\s\u3000]/g, '');
  if (!t || !options?.length) return null;

  // 直接是 A/B/C/D
  const direct = t.match(/^([A-D])$/);
  if (direct) return options.find((o) => o.key === direct[1]) ?? null;

  // 1/2/3/4
  const num = t.match(/^([1-4])$/);
  if (num) return options[Number(num[1]) - 1] ?? null;

  // "选A" / "我猜B" / "A吧"
  const loose = t.match(/([A-D])/);
  if (loose && t.length <= 6) return options.find((o) => o.key === loose[1]) ?? null;

  return null;
}

export class GuessGame {
  #entry;
  #options;
  #hints;
  #cfg;
  #clock;
  #phase = PHASE.IDLE;
  #phaseEndsAt = 0;
  #hintIndex = 0;
  #nextHintAt = 0;
  #votes = new Map(); // viewerId → { choice, name, at }
  #startedAt = 0;
  #endedAt = 0;

  constructor({ entry, options, hints, cfg, clock = () => Date.now() }) {
    this.#entry = entry;
    this.#options = options;
    this.#hints = hints;
    this.#cfg = cfg;
    this.#clock = clock;
  }

  get phase() {
    return this.#phase;
  }

  get active() {
    return ![PHASE.IDLE, PHASE.DONE].includes(this.#phase);
  }

  get entry() {
    return this.#entry;
  }

  get options() {
    return this.#options;
  }

  /** @returns {Array<object>} 启动时要发出的事件 */
  start(now = this.#clock()) {
    this.#phase = PHASE.INTRO;
    this.#startedAt = now;
    this.#phaseEndsAt = now + this.#cfg.introMs;
    return [{ type: 'intro', entry: this.#entry, options: this.#options, hints: this.#hints }];
  }

  /**
   * 推进时间。返回本 tick 需要发出去的事件（可能多条）。
   * @returns {Array<object>}
   */
  tick(now = this.#clock()) {
    const emit = [];
    if (!this.active) return emit;

    if (this.#phase === PHASE.INTRO && now >= this.#phaseEndsAt) {
      this.#phase = PHASE.HINTING;
      this.#hintIndex = 0;
      this.#nextHintAt = now;
      this.#phaseEndsAt = now + this.#cfg.hintGapMs * this.#hints.length + 800;
    }

    if (this.#phase === PHASE.HINTING) {
      while (this.#hintIndex < this.#hints.length && now >= this.#nextHintAt) {
        emit.push({ type: 'hint', index: this.#hintIndex, text: this.#hints[this.#hintIndex] });
        this.#hintIndex += 1;
        this.#nextHintAt = now + this.#cfg.hintGapMs;
      }
      if (this.#hintIndex >= this.#hints.length && now >= this.#nextHintAt) {
        this.#phase = PHASE.OPTIONS;
        this.#phaseEndsAt = now + this.#cfg.optionsMs;
        emit.push({ type: 'options', options: this.#options });
      }
    }

    if (this.#phase === PHASE.OPTIONS && now >= this.#phaseEndsAt) {
      this.#phase = PHASE.REVEAL;
      this.#phaseEndsAt = now + this.#cfg.revealMs;
      emit.push({ type: 'reveal', ...this.#result() });
    }

    if (this.#phase === PHASE.REVEAL && now >= this.#phaseEndsAt) {
      this.#phase = PHASE.DONE;
      this.#endedAt = now;
      emit.push({ type: 'done', ...this.#result() });
    }

    return emit;
  }

  /**
   * 观众投票。只有 options 阶段算数，每人只算第一票。
   * @returns {{accepted:boolean, reason?:string, choice?:object}}
   */
  vote({ viewerId, name, text }, now = this.#clock()) {
    if (this.#phase !== PHASE.OPTIONS) return { accepted: false, reason: 'not_voting' };
    if (!viewerId) return { accepted: false, reason: 'no_viewer' };
    if (this.#votes.has(viewerId)) return { accepted: false, reason: 'already_voted' };

    const choice = parseChoice(text, this.#options);
    if (!choice) return { accepted: false, reason: 'unparsed' };

    this.#votes.set(viewerId, { choice, name: name ?? '观众', at: now });
    return { accepted: true, choice };
  }

  #result() {
    const correct = this.#options.find((o) => o.correct);
    const counts = Object.fromEntries(this.#options.map((o) => [o.key, 0]));
    let firstCorrect = null;

    for (const v of this.#votes.values()) {
      counts[v.choice.key] = (counts[v.choice.key] ?? 0) + 1;
      if (v.choice.correct) {
        if (!firstCorrect || v.at < firstCorrect.at) firstCorrect = { name: v.name, at: v.at };
      }
    }

    return {
      answer: correct?.text ?? this.#entry.word,
      counts,
      totalVotes: this.#votes.size,
      correctCount: correct ? counts[correct.key] ?? 0 : 0,
      firstCorrect: firstCorrect?.name ?? null,
    };
  }

  /** 提前结束（手动停止 / 超时）。 */
  finish(now = this.#clock()) {
    if (!this.active) return [];
    this.#phase = PHASE.DONE;
    this.#endedAt = now;
    return [{ type: 'done', ...this.#result(), forced: true }];
  }

  snapshot(now = this.#clock()) {
    return {
      phase: this.#phase,
      word: this.#phase === PHASE.DONE ? this.#entry.word : null,
      category: this.#entry.category,
      length: Array.from(this.#entry.word).length,
      options: this.#options,
      hintIndex: this.#hintIndex,
      hintTotal: this.#hints.length,
      votes: this.#votes.size,
      leftMs: this.active ? Math.max(0, this.#phaseEndsAt - now) : 0,
      durationMs: this.#endedAt ? this.#endedAt - this.#startedAt : now - this.#startedAt,
    };
  }
}
