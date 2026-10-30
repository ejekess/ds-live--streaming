/**
 * 猜词游戏服务：把纯状态机接到时钟和副作用上。
 *
 * 它只负责「什么时候推进到哪一步」，具体说什么话、舞台怎么画由导演传进来的钩子决定。
 * 这样游戏模块不依赖 voice / stage / director，能被单独测试。
 */
import { logger } from '../log.mjs';
import { GuessGame, PHASE } from './engine.mjs';
import { pickWord, buildOptions, buildHints } from './words.mjs';
import { createReverseService } from './reverse-service.mjs';

const log = logger('games');

export function createGameService({ cfg, clock = () => Date.now(), random = Math.random, hooks = {} } = {}) {
  let game = null;
  let timer = null;
  let cooldownUntil = 0;
  const recent = [];
  const stats = { started: 0, finished: 0, votes: 0, correct: 0 };

  function clearTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function emit(event) {
    try {
      if (event.type === 'intro') hooks.onIntro?.(event);
      else if (event.type === 'hint') hooks.onHint?.(event);
      else if (event.type === 'options') hooks.onOptions?.(event);
      else if (event.type === 'reveal') hooks.onReveal?.(event);
      else if (event.type === 'done') hooks.onEnd?.(event);
    } catch (err) {
      log.error(`游戏钩子出错（${event.type}）：`, err);
    }
  }

  function finish(reason) {
    if (!game) return;
    const events = reason === 'forced' ? game.finish() : [];
    for (const e of events) emit(e);
    const snap = game.snapshot();
    game = null;
    clearTimer();
    cooldownUntil = clock() + (cfg.cooldownMs ?? 120_000);
    recent.push(snap.word ?? '');
    if (recent.length > 5) recent.shift();
    stats.finished++;
    log.info(`猜词结束（${reason}），本局 ${Math.round((snap.durationMs ?? 0) / 1000)}s`);
  }

  function tick() {
    if (!game) return;
    const events = game.tick();
    for (const e of events) emit(e);
    if (game && game.phase === PHASE.DONE) {
      // done 事件里已带结果，直接收尾
      const snap = game.snapshot();
      game = null;
      clearTimer();
      cooldownUntil = clock() + (cfg.cooldownMs ?? 120_000);
      recent.push(snap.word ?? '');
      if (recent.length > 5) recent.shift();
      stats.finished++;
    }
  }

  return {
    /** 现在能不能开一局 */
    canStart() {
      if (game) return { ok: false, reason: 'busy' };
      if (clock() < cooldownUntil) return { ok: false, reason: 'cooldown', leftMs: cooldownUntil - clock() };
      return { ok: true };
    },

    /**
     * 开一局。
     * @returns {{ok:true, word:string, category:string} | {ok:false, reason:string}}
     */
    start(ctx = {}) {
      const gate = this.canStart();
      if (!gate.ok) return gate;

      const entry = pickWord({ avoid: recent, random });
      const options = buildOptions(entry, { random });
      const hints = buildHints(entry, { count: cfg.hintCount ?? 3 });

      game = new GuessGame({ entry, options, hints, cfg: cfg.phases ?? cfg, clock });
      const events = game.start();
      for (const e of events) emit(e);

      stats.started++;
      clearTimer();
      timer = setInterval(tick, 500);
      timer.unref?.();
      log.info(`猜词开始：${entry.category} · ${Array.from(entry.word).length} 个字（词已隐藏）`);
      return { ok: true, word: entry.word, category: entry.category, options: options.map((o) => o.key) };
    },

    /** 观众发弹幕投票。 */
    vote(ev) {
      if (!game) return { accepted: false, reason: 'no_game' };
      const r = game.vote({ viewerId: ev.user?.id, name: ev.user?.name, text: ev.text });
      if (r.accepted) {
        stats.votes++;
        if (r.choice.correct) stats.correct++;
      }
      return r;
    },

    stop(reason = 'forced') {
      if (!game) return { ok: false, reason: 'no_game' };
      finish(reason);
      return { ok: true };
    },

    get active() {
      return Boolean(game);
    },

    snapshot() {
      const snap = game?.snapshot() ?? null;
      return {
        active: Boolean(game),
        phase: snap?.phase ?? 'idle',
        category: snap?.category ?? null,
        length: snap?.length ?? null,
        votes: snap?.votes ?? 0,
        leftMs: snap?.leftMs ?? 0,
        cooldownLeftMs: Math.max(0, cooldownUntil - clock()),
        stats: { ...stats },
        // 注意：答案不在快照里（管控台也不该提前看到），只有结束时才出现在事件里
      };
    },
  };
}

/**
 * 按配置选游戏模式。
 *   reverse（默认）：观众藏词、她来问
 *   forward        ：她描述、观众猜
 * 两种服务的对外接口一致（canStart/start/vote/stop/snapshot/active），导演不用关心用哪个。
 */
export function createAnyGameService({ cfg = {}, clock, random, hooks = {} } = {}) {
  if ((cfg.mode ?? 'reverse') === 'reverse') {
    return createReverseService({
      cfg,
      clock,
      random,
      hooks: {
        onPick: hooks.onRevPick,
        onAsk: hooks.onRevAsk,
        onAnswer: hooks.onRevAnswer,
        onResult: hooks.onRevResult,
        onReveal: hooks.onRevReveal,
        onEnd: hooks.onRevEnd,
        // 决策链路：漏了这三个，模型就永远收不到请求（之前就是这么静默断开的）
        onDecide: hooks.onDecide,
        onDecideEvent: hooks.onDecideEvent,
        onWrongGuess: hooks.onWrongGuess,
      },
    });
  }
  return createGameService({ cfg, clock, random, hooks });
}
