/**
 * 反向猜词：观众藏着答案，她来问。
 *
 * 一轮 = 选题 → 提问 → 回答。重复 N 轮后系统揭晓。
 * 她**全程不知道答案**，也不做推理——"猜不出来"是设计的一部分。
 *
 * 每个问题自带三个选项（见 questions.mjs），所以不是清一色的"是/不是"，
 * "它大概多大"就是「比拳头小 / 差不多 / 比拳头大」。
 */
import { pickQuestions, parseAnswer, parseQuestionPick, verdictOf, ABSTAIN } from './questions.mjs';
import { isCorrectGuess } from './decide.mjs';

export const PHASE = {
  IDLE: 'idle',
  /** 开场：先亮个相，别让问题突然砸出来 */
  START: 'start',
  PICK: 'pick',
  ASK: 'ask',
  ANSWER: 'answer',
  /** 等模型决策：继续问还是猜 */
  DECIDE: 'decide',
  REVEAL: 'reveal',
  DONE: 'done',
};

const DEFAULT_PHASES = {
  pickMs: 10_000,
  askMs: 4_000,
  answerMs: 15_000,
  revealMs: 8_000,
  rounds: 5,
  verdictThreshold: 0.6,
};

export class ReverseGame {
  #word;
  #category;
  #cfg;
  #clock;
  #random;
  #phase = PHASE.IDLE;
  #phaseEndsAt = 0;
  #round = 0;
  #asked = [];
  #candidates = [];
  #current = null; // { question, pickVotes: Map, answerVotes: Map }
  #history = [];
  #voteTotal = 0;
  #guesses = [];      // 这一局猜过什么（含猜错的）
  #pending = false;   // 是否在等决策
  #startedAt = 0;
  #endedAt = 0;

  constructor({ word, category, cfg, clock = () => Date.now(), random = Math.random }) {
    this.#word = word;
    this.#category = category;
    this.#cfg = { ...DEFAULT_PHASES, ...(cfg ?? {}) };
    this.#clock = clock;
    this.#random = random;
  }

  get phase() {
    return this.#phase;
  }

  get active() {
    return ![PHASE.IDLE, PHASE.DONE].includes(this.#phase);
  }

  get word() {
    return this.#word;
  }

  get history() {
    return this.#history.map((h) => ({ ...h }));
  }

  start(now = this.#clock(), ctx = {}) {
    this.#startedAt = now;
    this.#round = 1;
    this.#voteTotal = 0;
    this.#guesses = [];
    // startMs <= 0 直接开第一轮（自检和"不要开场"的场合用）
    if (!(this.#cfg.startMs > 0)) return this.#openPick(now);

    // 先停 startMs 亮个相，再进第一轮——否则礼物的谢谢刚说完问题就出来了
    this.#phase = PHASE.START;
    this.#phaseEndsAt = now + (this.#cfg.startMs ?? 3000);
    return [{
      type: 'start',
      category: this.#category,
      wordLength: Array.from(this.#word).length,
      giver: ctx.giver ?? null,
      totalRounds: this.#cfg.rounds,
    }];
  }

  #openPick(now) {
    this.#candidates = pickQuestions(this.#asked, 3, this.#random);
    this.#current = { pickVotes: new Map(), answerVotes: new Map(), question: null };
    this.#phase = PHASE.PICK;
    this.#pending = false;
    this.#phaseEndsAt = now + this.#cfg.pickMs;
    return [
      {
        type: 'pick',
        round: this.#round,
        totalRounds: this.#cfg.rounds,
        options: this.#candidates.map((q, i) => ({ key: String(i + 1), text: q.text })),
        category: this.#category,
        wordLength: Array.from(this.#word).length,
        // 只给舞台显示用：观众是「幽灵」，必须看得到答案；
        // 但这个名字刻意不叫 word —— 它不该进入任何模型调用。
        displayWord: this.#word,
      },
    ];
  }

  tick(now = this.#clock()) {
    const emit = [];
    if (!this.active) return emit;

    if (this.#phase === PHASE.START && now >= this.#phaseEndsAt) {
      emit.push(...this.#openPick(now));
    } else if (this.#phase === PHASE.PICK && now >= this.#phaseEndsAt) {
      // 没人投票就随机选一个，别卡住
      const counts = [0, 0, 0];
      for (const idx of this.#current.pickVotes.values()) counts[idx] += 1;
      let best = counts.indexOf(Math.max(...counts));
      if (counts.every((c) => c === 0)) best = Math.floor(this.#random() * this.#candidates.length);

      const question = this.#candidates[best] ?? this.#candidates[0];
      this.#current.question = question;
      this.#asked.push(question.text);

      this.#phase = PHASE.ASK;
      this.#phaseEndsAt = now + this.#cfg.askMs;
      emit.push({ type: 'ask', round: this.#round, question: question.text, pickCounts: counts });
    } else if (this.#phase === PHASE.ASK && now >= this.#phaseEndsAt) {
      this.#phase = PHASE.ANSWER;
      this.#phaseEndsAt = now + this.#cfg.answerMs;
      emit.push({
        type: 'answer',
        round: this.#round,
        question: this.#current.question.text,
        options: this.#current.question.options,
      });
    } else if (this.#phase === PHASE.ANSWER && now >= this.#phaseEndsAt) {
      const result = this.#tally();
      this.#history.push({ question: this.#current.question.text, ...result });
      emit.push({ type: 'result', round: this.#round, question: this.#current.question.text, ...result });

      // 停下来等决策：模型说"继续问"才开下一轮，说"猜"就结算
      this.#phase = PHASE.DECIDE;
      this.#phaseEndsAt = now + (this.#cfg.decideTimeoutMs ?? 6000);
      this.#pending = true;
      const forced = this.#round >= this.#cfg.rounds || this.#guesses.length >= (this.#cfg.maxGuesses ?? 3);
      emit.push({
        type: 'decide',
        round: this.#round,
        totalRounds: this.#cfg.rounds,
        forced,
        category: this.#category,
        wordLength: Array.from(this.#word).length,
        history: this.history,
        guesses: [...this.#guesses],
      });
    } else if (this.#phase === PHASE.DECIDE && now >= this.#phaseEndsAt) {
      // 模型没回话（超时/挂了）：当作"继续问"，最后一轮就直接揭晓
      emit.push(...this.applyDecision({ action: 'ask' }, now));
    } else if (this.#phase === PHASE.REVEAL && now >= this.#phaseEndsAt) {
      this.#phase = PHASE.DONE;
      this.#endedAt = now;
      emit.push({ type: 'done', word: this.#word, category: this.#category, history: this.history });
    }

    return emit;
  }

  /**
   * 落一下模型的决策。**猜对猜错由这里判，模型没有结束游戏的权力。**
   * @param {{action:'ask'|'guess', guess:string|null}} decision
   * @returns {Array<object>} 需要发出的事件
   */
  applyDecision(decision = {}, now = this.#clock()) {
    if (this.#phase !== PHASE.DECIDE) return [];
    this.#pending = false;
    const emit = [];
    const action = decision.action === 'guess' ? 'guess' : 'ask';
    const guess = decision.guess ?? null;

    let solved = false;
    if (action === 'guess' && guess) {
      this.#guesses.push(guess);
      solved = isCorrectGuess(guess, this.#word);
    }

    const exhausted =
      this.#round >= this.#cfg.rounds || this.#guesses.length >= (this.#cfg.maxGuesses ?? 3);

    if (solved || exhausted) {
      this.#phase = PHASE.REVEAL;
      this.#phaseEndsAt = now + this.#cfg.revealMs;
      emit.push({
        type: 'reveal',
        word: this.#word,
        category: this.#category,
        history: this.history,
        rounds: this.#round,
        solved,
        guess,
        guesses: [...this.#guesses],
      });
    } else {
      // 猜错了要说出来，但游戏继续
      if (guess) emit.push({ type: 'wrongGuess', guess, round: this.#round });
      this.#round += 1;
      emit.push(...this.#openPick(now));
    }
    return emit;
  }

  /** 统计：每个选项多少票 + 弃权页；多数决算 verdict。 */
  #tally() {
    const options = this.#current.question.options;
    const counts = Object.fromEntries(options.map((o) => [o.key, 0]));
    let abstain = 0;
    for (const v of this.#current.answerVotes.values()) {
      if (v === ABSTAIN) abstain += 1;
      else counts[v] = (counts[v] ?? 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const verdict = verdictOf(counts, options);
    return { counts, total, abstain, options, verdict };
  }

  /**
   * 观众投票。选题阶段收 1/2/3，回答阶段收选项文字或 1/2/3（4=弃权）。
   * 每人每阶段一票，改票无效。
   */
  vote({ viewerId, name, text }) {
    if (!viewerId) return { accepted: false, reason: 'no_viewer' };

    if (this.#phase === PHASE.PICK) {
      if (this.#current.pickVotes.has(viewerId)) return { accepted: false, reason: 'already_voted' };
      const idx = parseQuestionPick(text);
      if (!idx || idx > this.#candidates.length) return { accepted: false, reason: 'unparsed' };
      this.#current.pickVotes.set(viewerId, idx - 1);
      this.#voteTotal += 1;
      return { accepted: true, kind: 'pick', index: idx - 1, text: this.#candidates[idx - 1].text };
    }

    if (this.#phase === PHASE.ANSWER) {
      if (this.#current.answerVotes.has(viewerId)) return { accepted: false, reason: 'already_voted' };
      const key = parseAnswer(text, this.#current.question.options);
      if (!key) return { accepted: false, reason: 'unparsed' };
      this.#current.answerVotes.set(viewerId, key);
      this.#voteTotal += 1;
      return { accepted: true, kind: 'answer', key, text };
    }

    return { accepted: false, reason: 'not_voting' };
  }

  finish(now = this.#clock()) {
    if (!this.active) return [];
    this.#phase = PHASE.DONE;
    this.#endedAt = now;
    return [{ type: 'done', word: this.#word, category: this.#category, history: this.history, forced: true }];
  }

  snapshot(now = this.#clock()) {
    return {
      mode: 'reverse',
      phase: this.#phase,
      round: this.#round,
      totalRounds: this.#cfg.rounds,
      // 答案只在 reveal/done 之后才对外暴露
      word: [PHASE.REVEAL, PHASE.DONE].includes(this.#phase) ? this.#word : null,
      category: this.#category,
      question: this.#current?.question?.text ?? null,
      candidates: this.#candidates.map((q) => q.text),
      votes: this.#voteTotal,
      guesses: [...this.#guesses],
      solved: [PHASE.REVEAL, PHASE.DONE].includes(this.#phase) && this.#guesses.some((g) => g === this.#word),
      history: this.#history,
      leftMs: this.active ? Math.max(0, this.#phaseEndsAt - now) : 0,
      durationMs: this.#endedAt ? this.#endedAt - this.#startedAt : now - this.#startedAt,
    };
  }
}

export { ABSTAIN };
