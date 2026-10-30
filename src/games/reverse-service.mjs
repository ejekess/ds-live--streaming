/**
 * 反向猜词服务：把状态机接到时钟和副作用上（接口与正向版一致，导演可互换）。
 */
import { logger } from '../log.mjs';
import { ReverseGame, PHASE } from './reverse.mjs';
import { normalizeDecision } from './decide.mjs';
import { WORDS } from './words.mjs';

const log = logger('games');
const DEFAULT_PHASES = { pickMs: 10_000, askMs: 4_000, answerMs: 15_000, revealMs: 8_000, rounds: 5 };

export function createReverseService({ cfg = {}, clock = () => Date.now(), random = Math.random, hooks = {} } = {}) {
  // 注意：不能在这里把 phases 拷死——管控台/演示脚本会热改它
  const phasesNow = () => ({ ...DEFAULT_PHASES, ...(cfg.phases ?? {}) });
  let game = null;
  let timer = null;
  let cooldownUntil = 0;
  const recent = [];
  const stats = { started: 0, finished: 0, picks: 0, answers: 0 };

  function clearTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function emit(ev) {
    const fn = {
      start: hooks.onStart,
      pick: hooks.onPick,
      ask: hooks.onAsk,
      answer: hooks.onAnswer,
      result: hooks.onResult,
      decide: hooks.onDecideEvent,
      wrongGuess: hooks.onWrongGuess,
      reveal: hooks.onReveal,
      done: hooks.onEnd,
    }[ev.type];
    try {
      fn?.(ev);
    } catch (err) {
      log.error(`游戏钩子出错（${ev.type}）：`, err);
    }
  }

  function tick() {
    if (!game) return;
    for (const ev of game.tick()) {
      emit(ev);
      // 状态机停在这里等决策：问模型"继续问还是猜"
      if (ev.type === 'decide') resolveDecision(ev);
    }
    if (game && game.phase === PHASE.DONE) finishCleanup(game.snapshot());
  }

  /**
   * 问模型要一个决策，然后落给状态机。
   * 任何异常/超时都当作"继续问"，绝不让游戏卡住。
   */
  async function resolveDecision(ev) {
    const current = game;
    if (!current) return;

    let raw = null;
    try {
      const timeoutMs = ev.forced ? 4000 : 5000;
      raw = await Promise.race([
        Promise.resolve(hooks.onDecide?.(ev) ?? null),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), timeoutMs);
          t.unref?.();
        }),
      ]);
    } catch (err) {
      log.warn('决策钩子出错，当作继续问：', err?.message);
      raw = null;
    }

    // 期间可能超时被状态机推进 / 被手动停止
    if (game !== current || current.phase !== PHASE.DECIDE) return;

    // 演示/自检用：没有模型时也能演一遍「她猜」的完整链路
    const demo = cfg.reverse?.demoGuess ?? cfg.demoGuess;
    if (raw == null && demo) {
      if (demo === 'wrong' && !ev.guesses.length) {
        raw = { action: 'guess', guess: '西瓜', reason: '演示：故意猜错' };
      } else if (demo === 'solved' && ev.round >= 2) {
        raw = { action: 'guess', guess: current.word, reason: '演示：猜对提前结束' };
      }
    }

    const decision = normalizeDecision(raw, { forced: ev.forced });
    for (const e of current.applyDecision(decision)) emit(e);
    if (current.phase === PHASE.DONE) finishCleanup(current.snapshot());
  }

  function finishCleanup(snap) {
    game = null;
    clearTimer();
    cooldownUntil = clock() + (cfg.cooldownMs ?? 120_000);
    recent.push(snap?.word ?? '');
    if (recent.length > 5) recent.shift();
    stats.finished++;
    log.info(`反向猜词结束：${snap?.round ?? '?'} 轮，${Math.round((snap?.durationMs ?? 0) / 1000)}s`);
  }

  return {
    get active() {
      return Boolean(game);
    },

    canStart() {
      if (game) return { ok: false, reason: 'busy' };
      if (clock() < cooldownUntil) return { ok: false, reason: 'cooldown', leftMs: cooldownUntil - clock() };
      return { ok: true };
    },

    start(ctx = {}) {
      const gate = this.canStart();
      if (!gate.ok) return gate;

      const avoid = new Set(recent);
      const pool = WORDS.filter((w) => !avoid.has(w.word));
      const entry = (pool.length ? pool : WORDS)[Math.floor(random() * (pool.length ? pool.length : WORDS.length))];

      game = new ReverseGame({ word: entry.word, category: entry.category, cfg: phasesNow(), clock, random });
      for (const ev of game.start(clock(), ctx)) emit(ev);
      stats.started++;
      clearTimer();
      timer = setInterval(tick, 400);
      timer.unref?.();
      log.info(`反向猜词开始：${entry.category} · ${Array.from(entry.word).length} 个字（她不知道答案）`);
      // 返回值不带 word：调用方（管控台/日志）也不该看到答案
      return { ok: true, mode: 'reverse', category: entry.category, length: Array.from(entry.word).length };
    },

    vote(ev) {
      if (!game) return { accepted: false, reason: 'no_game' };
      const r = game.vote({ viewerId: ev.user?.id, name: ev.user?.name, text: ev.text });
      if (r.accepted) {
        if (r.kind === 'pick') stats.picks++;
        else stats.answers++;
      }
      return r;
    },

    stop() {
      if (!game) return { ok: false, reason: 'no_game' };
      for (const ev of game.finish()) emit(ev);
      finishCleanup(game.snapshot());
      return { ok: true };
    },

    /** 只给舞台用：包含答案，让中途刷新的页面能重建词板。**不要给管控台/模型**。 */
    stageSnapshot() {
      if (!game) return null;
      const snap = game.snapshot();
      return {
        active: true,
        phase: snap.phase,
        round: snap.round,
        totalRounds: snap.totalRounds,
        category: snap.category,
        length: Array.from(game.word ?? '').length,
        word: game.word,
        question: snap.question,
        candidates: snap.candidates,
      };
    },

    snapshot() {
      const snap = game?.snapshot() ?? null;
      return {
        mode: 'reverse',
        active: Boolean(game),
        phase: snap?.phase ?? 'idle',
        round: snap?.round ?? 0,
        totalRounds: snap?.totalRounds ?? phasesNow().rounds,
        category: snap?.category ?? null,
        word: snap?.word ?? null,
        question: snap?.question ?? null,
        votes: snap?.votes ?? 0,
        leftMs: snap?.leftMs ?? 0,
        cooldownLeftMs: Math.max(0, cooldownUntil - clock()),
        history: snap?.history ?? [],
        stats: { ...stats },
      };
    },
  };
}
