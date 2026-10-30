/**
 * 编排器：整场直播的「导演」。
 *
 * 四件事，按优先级：
 *   1. 打赏 → 立刻演出（钱到位了，画面必须到位），并可能发点歌券；
 *   2. 点歌 → 走 songService（门禁/券/队列），结果翻译成一句话说出来；
 *   3. 弹幕 → 慢挑选，挑一条回话；
 *   4. 其它（点赞/进场/在线人数）→ 只更新状态。
 *
 * 它自己**不做**任何具体实现：不合成语音、不渲染歌、不判断歌名能不能唱。
 * 那些分别在 voice / songs / audio 里。导演只负责"什么时候调谁"。
 */
import { logger } from './log.mjs';
import { giftBehavior, followBehavior, comboLine } from './reaction/behavior.mjs';
import { ReactionQueue } from './reaction/queue.mjs';
import { ComboTracker } from './reaction/combo.mjs';
import { CommentSelector } from './interaction/selector.mjs';
import { parseSongRequest } from './interaction/songIntent.mjs';
import { createAnyGameService } from './games/index.mjs';
import { createSpeaker } from './audio/speech.mjs';
import { displayName, oneLine, forSpeech } from './text.mjs';
import { make } from './events.mjs';

const log = logger('director');

/** 点歌失败原因 → 她该说的那句话。集中在一处，方便调语气。 */
const SONG_LINES = {
  no_credit: '想点歌的话，先送我一个小礼物呀',
  tier_too_low: '点歌要先送礼物哦，甜甜圈起步就行',
  daily_limit: '今天已经点过好几首啦，明天再来好不好',
  rejected: '这首我不太敢唱，换一首好不好',
  not_in_library: '这首我还没学会，换一首我会的好不好',
  queue_full: '排队的人有点多，等我唱完这两首',
  empty_library: '曲库还空着，等我学会几首再说',
};

export class Director {
  #cfg;
  #brain;
  #stage;
  #catalog;
  #voice;
  #audio;
  #speaker;
  #stats;
  #songs;
  #game;
  #queue;
  #combo;
  #selector;
  #timers = [];
  #running = false;
  /** 演出占用的时间窗：这之前不插话，免得「刚说完谢谢就被闲聊顶掉」 */
  #busyUntil = 0;
  /** 报幕中：此时不能再取下一首，否则会连续报两首 */
  #announcingId = null;
  #lastSongEndAt = 0;
  #voiceSeq = 0;

  #state = {
    viewers: 0,
    likes: 0,
    comments: 0,
    gifts: 0,
    diamonds: 0,
    songs: 0,
    startedAt: 0,
    lastEventAt: 0,
    topGifter: null,
    lastPerformance: null,
    lastReply: null,
    lastSong: null,
  };

  constructor({ cfg, brain, stage, catalog, voice, audio, songs, stats }) {
    this.#cfg = cfg;
    this.#brain = brain;
    this.#stage = stage;
    this.#catalog = catalog;
    this.#voice = voice;
    this.#audio = audio;
    // 串行播报：一次只说一句，说完才说下一句（避免半句被掐）
    this.#speaker = createSpeaker({
      voice,
      audio,
      push: (msg) => this.#push(msg),
      hasAudience: () => (typeof this.#stage.hasClients === 'function' ? this.#stage.hasClients() : true),
    });
    this.#songs = songs;
    this.#stats = stats ?? null;

    this.#combo = new ComboTracker({
      windowMs: cfg.reaction.comboWindowMs,
      announceAt: cfg.reaction.announceComboAt,
    });

    this.#queue = new ReactionQueue({
      perform: (spec, item) => this.#perform(spec, item),
      cooldownMs: cfg.reaction.cooldownMs,
      maxPerMinute: cfg.reaction.maxPerMinute,
    });

    this.#selector = new CommentSelector(cfg.interaction);

    // 猜词游戏：状态机自己走时间，这里只负责"说什么、画什么"
    this.#game = createAnyGameService({
      cfg: cfg.games,
      hooks: {
        onIntro: (e) => {
          const len = Array.from(e.entry.word).length;
          this.#push({ type: 'game', action: 'intro', category: e.entry.category, length: len, hintTotal: e.hints.length });
          this.#speak(`来玩个猜词！提示一下，这是${e.entry.category}，${len}个字，你们猜`, { ms: 4200, mood: 'excited' }).catch(() => {});
        },
        onHint: (e) => {
          this.#push({ type: 'game', action: 'hint', index: e.index, text: e.text });
          this.#speak(e.text, { ms: 3200, mood: 'thinking', priority: 'game' }).catch(() => {});
        },
        onOptions: (e) => {
          this.#push({ type: 'game', action: 'options', options: e.options, ms: this.#cfg.games?.phases?.optionsMs ?? 45000 });
          const list = e.options.map((o) => `${o.key}：${o.text}`).join('，');
          this.#speak(`现在选一个，${list}`, { ms: 5200, mood: 'playful' }).catch(() => {});
        },
        onReveal: (e) => {
          this.#push({
            type: 'game',
            action: 'reveal',
            answer: e.answer,
            counts: e.counts,
            correctCount: e.correctCount,
            totalVotes: e.totalVotes,
            firstCorrect: e.firstCorrect,
          });
          const line = e.correctCount > 0
            ? `答案是${e.answer}！${e.firstCorrect ? `${e.firstCorrect} 最快猜对` : `${e.correctCount} 个人猜对了`}`
            : `答案是${e.answer}，居然没人猜对～`;
          this.#speak(line, { ms: 5200, mood: 'excited' }).catch(() => {});
        },
        // —— 反向模式（观众藏词、她来问） ——
        // 每轮结束：问模型「继续问还是猜」。模型只交决策，判对错在状态机里
        onDecide: (ev) =>
          this.#brain?.decide?.({
            category: ev.category,
            wordLength: ev.wordLength,
            history: ev.history,
            guesses: ev.guesses,
            forced: ev.forced,
          }) ?? null,
        onDecideEvent: () => {
          // 决策期间舞台不用额外画东西，保持当前轮次即可
        },
        onWrongGuess: (e) => {
          this.#push({ type: 'game', action: 'wrongGuess', guess: e.guess });
          this.#speak(`我猜是${e.guess}……不对啊`, { ms: 2600, mood: 'confused', priority: 'game' }).catch(() => {});
        },
        onRevStart: (e) => {
          this.#push({ type: 'game', action: 'start', category: e.category, length: e.wordLength, giver: e.giver, rounds: e.totalRounds });
          const who = e.giver ? `${e.giver}解锁了` : '';
          this.#speak(`猜词开始啦${who}！${e.category}，${e.wordLength}个字，你们来藏`, { ms: 3400, mood: 'excited', priority: 'game' }).catch(() => {});
        },
        onRevPick: (e) => {
          const list = e.options.map((o) => `${o.key}. ${o.text}`).join('，');
          this.#push({
            type: 'game',
            action: 'pick',
            round: e.round,
            totalRounds: e.totalRounds,
            options: e.options,
            category: e.category,
            length: e.wordLength,
            word: e.displayWord,
          });
          // 三个问题太长，念出来没完没了；让她只说一句，题目看屏幕
          this.#speak(`第 ${e.round} 轮，你们想让我问什么？看看屏幕`, { ms: 3600, mood: 'playful', priority: 'game' }).catch(() => {});
        },
        onRevAsk: (e) => {
          this.#push({ type: 'game', action: 'ask', round: e.round, question: e.question });
          this.#speak(`${e.question}？`, { ms: 3000, mood: 'thinking', priority: 'game' }).catch(() => {});
        },
        onRevAnswer: (e) => {
          this.#push({
            type: 'game',
            action: 'answer',
            round: e.round,
            question: e.question,
            options: e.options,
            ms: this.#cfg.games?.phases?.answerMs ?? 15000,
          });
          this.#speak('你们告诉我，是、不是、还是不确定', { ms: 3200, mood: 'thinking' }).catch(() => {});
        },
        onRevResult: (e) => {
          const v = e.verdict ?? {};
          const line =
            v.key === 'unclear' ? '你们说法都不一样…我再想想' : `大家说：${v.text}`;
          this.#push({
            type: 'game',
            action: 'result',
            round: e.round,
            question: e.question,
            counts: e.counts,
            abstain: e.abstain ?? 0,
            verdict: v,
          });
          this.#speak(line, { ms: 2600, mood: 'thinking', priority: 'game' }).catch(() => {});
        },
        onRevReveal: (e) => {
          this.#push({ type: 'game', action: 'reveal', word: e.word, category: e.category, history: e.history, solved: e.solved, guesses: e.guesses ?? [] });
          const line = e.solved
            ? `我猜对了！就是${e.word}，你们藏得还是不够好嘛`
            : `原来是${e.word}！你们藏得也太好了`;
          this.#speak(line, { ms: 5000, mood: 'excited', priority: 'game' }).catch(() => {});
        },
        onRevEnd: () => {
          const snap = this.#game?.snapshot?.();
          this.#stats?.addGame({ rounds: snap?.round ?? 0, votes: snap?.votes ?? 0 });
          this.#push({ type: 'game', action: 'end' });
          this.#speak('这局结束啦，下局还玩不玩', { ms: 3000, mood: 'happy', priority: 'game' }).catch(() => {});
        },
        onEnd: () => {
          this.#push({ type: 'game', action: 'end' });
          this.#speak('这局结束啦，谢谢陪我玩', { ms: 3000, mood: 'happy' }).catch(() => {});
        },
      },
    });

    // 一首歌播完：结算队列、回到待机
    this.#audio?.onMusicEnded((item, reason) => {
      this.#lastSongEndAt = Date.now();
      if (reason === 'error' || reason === 'timeout') {
        log.warn(`歌曲 ${item.id} 播放异常结束（${reason}）`);
      }
      this.#songs?.markDone(item.id).catch((err) => log.error('标记歌曲完成失败：', err));
      this.#push({ type: 'base', mood: 'neutral', props: [] });
      this.#state.lastSong = { at: Date.now(), id: item.id, reason };
    });
  }

  /** 舞台中途接入时补一条当前对局，避免白板。 */
  gameStageSnapshot() {
    const snap = this.#game?.stageSnapshot?.();
    if (!snap?.active) return null;
    return {
      type: 'game',
      action: 'resync',
      phase: snap.phase,
      round: snap.round,
      totalRounds: snap.totalRounds,
      category: snap.category,
      length: snap.length,
      word: snap.word,
      question: snap.question,
    };
  }

  get state() {
    return {
      ...this.#state,
      uptimeMs: this.#state.startedAt ? Date.now() - this.#state.startedAt : 0,
      queue: this.#queue.stats,
      selector: this.#selector.stats,
      audio: this.#audio?.state() ?? null,
      songs: this.#songs?.snapshot() ?? null,
      voice: this.#voice?.stats() ?? null,
      games: this.#game?.snapshot() ?? null,
    };
  }

  get queue() {
    return this.#queue;
  }

  get selector() {
    return this.#selector;
  }

  #push(msg) {
    try {
      this.#stage.push(msg);
    } catch (err) {
      log.error('推送到舞台失败：', err);
    }
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    this.#state.startedAt = Date.now();
    this.#queue.setOptions({
      cooldownMs: this.#cfg.reaction.cooldownMs,
      maxPerMinute: this.#cfg.reaction.maxPerMinute,
    });

    // 主循环：尝试搭话
    this.#timers.push(
      setInterval(() => {
        this.#tickInteraction().catch((err) => log.error('搭话循环出错：', err));
      }, 1200),
    );
    // 点歌循环：推进渲染 + 看有没有该播的
    this.#timers.push(
      setInterval(() => {
        this.#tickSongs().catch((err) => log.error('点歌循环出错：', err));
      }, 1500),
    );
    // 刷屏计数降温
    this.#timers.push(setInterval(() => this.#selector.decay(), 30_000));
    // 清理已完成记录
    this.#timers.push(setInterval(() => this.#songs?.prune().catch(() => {}), 300_000));

    this.#push({ type: 'base', mood: 'neutral', props: [] });
    log.info('导演已就位');
  }

  async stop() {
    this.#running = false;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    this.#queue.stop();
    this.#combo.stop();
    this.#selector.clear();
    this.#audio?.stopMusic();
    this.#voice?.stop();
  }

  // ————————————————————————————————————————————————
  // 事件入口
  // ————————————————————————————————————————————————

  handle(events) {
    for (const ev of events) {
      if (!ev) continue;
      this.#state.lastEventAt = ev.ts || Date.now();
      switch (ev.type) {
        case 'comment':
          this.#onComment(ev);
          break;
        case 'gift':
          this.#onGift(ev);
          break;
        case 'follow':
          this.#onFollow(ev);
          break;
        case 'like':
          this.#state.likes = Math.max(this.#state.likes, ev.total || 0) || this.#state.likes + ev.count;
          this.#stats?.addLike(ev.count || 1);
          break;
        case 'enter':
          this.#stats?.addEnter();
          break;
        case 'stats':
          this.#state.viewers = ev.viewers || this.#state.viewers;
          break;
        default:
          break;
      }
    }
  }

  #onComment(ev) {
    this.#state.comments++;
    this.#stats?.addComment();
    this.#push({ type: 'feed', user: displayName(ev.user.name), text: oneLine(ev.text, 40), at: ev.ts });
    if (ev.user.isAnchor) return;

    // 游戏进行中：所有弹幕都当成投票，不再喂给闲聊（否则会互相打断）
    if (this.#game?.active) {
      const voted = this.#game.vote(ev);
      if (voted.accepted) {
        // 正向返回 key（A/B/C/D），反向返回 index/value——两种都兼容
        const key = voted.choice?.key ?? (voted.kind === 'pick' ? String(voted.index + 1) : voted.value);
        this.#push({ type: 'game', action: 'vote', key, user: displayName(ev.user.name) });
        this.#stats?.addVote(ev.user?.id);
      }
      return;
    }

    // 点歌优先级高于闲聊：命中了就不再进候选池，避免同一句话被回两次
    const parsed = this.#cfg.songs?.enabled === false ? { isRequest: false } : parseSongRequest(ev.text);
    if (parsed.isRequest) {
      this.#handleSongRequest(ev, parsed).catch((err) => log.error('处理点歌出错：', err));
      return;
    }

    this.#selector.offer(ev);
  }

  #onGift(ev) {
    const { diamonds, tier } = this.#catalog.resolve(ev);
    this.#stats?.addGift({
      user: ev.user,
      giftName: ev.giftName,
      diamonds,
      tier: tier?.tier ?? 1,
      count: ev.count || 1,
    });
    const enriched = { ...ev, diamonds, unitDiamonds: diamonds || ev.unitDiamonds };
    const combo = this.#combo.add(enriched);

    this.#state.gifts++;
    this.#state.diamonds += Math.max(0, ev.totalDiamonds);

    const name = displayName(ev.user.name);
    const total = (this.#state.topGifter?.[ev.user.id] ?? 0) + Math.max(0, ev.totalDiamonds);
    this.#recordTopGifter(ev.user.id, name, total);

    this.#push({
      type: 'gift',
      user: name,
      gift: ev.giftName,
      count: combo.count,
      diamonds: combo.diamonds,
      tier: tier.tier,
      at: ev.ts,
    });

    // 打赏换点歌券（T3 起）。发券失败（太频繁/档位不够）静默处理，不打扰演出。
    if (this.#cfg.songs?.enabled !== false && tier.tier >= 3 && this.#songs) {
      this.#songs
        .grant(ev.user.id, tier.tier)
        .then((r) => {
          if (r.granted) log.info(`${name} 获得点歌券，余额 ${r.credits}`);
        })
        .catch((err) => log.warn('发券失败：', err));
    }

    // 触发猜词：达到档位就开一局（延迟一点，让感谢的话先说完）
    const g = this.#cfg.games;
    if (g?.enabled) {
      const byName = (g.triggerGifts ?? []).includes(ev.giftName);
      const byTier = tier.tier >= (g.minTier ?? 4);
      if (byName || byTier) {
        setTimeout(() => {
          if (this.#game.canStart().ok) {
            const r = this.#game.start({ trigger: 'gift', giver: displayName(ev.user.name) });
            if (r.ok) log.info(`🎲 礼物触发猜词：${ev.giftName}`);
          }
        }, 2400);
      }
    }

    if (!combo.perform) return;

    const spec = giftBehavior({
      diamonds: combo.diamonds,
      name,
      giftName: ev.giftName,
      count: combo.count,
      seed: ev.ts,
    });
    this.#queue.enqueue({
      label: `gift:${ev.user.id}:${ev.giftId}:${ev.ts}`,
      priority: spec.priority,
      spec: { ...spec, source: 'gift', user: name },
      durationMs: spec.ms,
    });

    if (combo.milestone) {
      const line = comboLine({ name, giftName: ev.giftName, count: combo.count });
      if (line) this.#push({ type: 'say', text: line, ms: 2400, priority: 3 });
    }
  }

  #recordTopGifter(id, name, total) {
    const cur = this.#state.topGifter;
    if (!cur || total > cur.total) this.#state.topGifter = { id, name, total };
  }

  #onFollow(ev) {
    this.#stats?.addFollow();
    const name = displayName(ev.user.name);
    const spec = followBehavior({ name, seed: ev.ts });
    this.#queue.enqueue({
      label: `follow:${ev.user.id}`,
      priority: spec.priority,
      spec: { ...spec, source: 'follow' },
      durationMs: spec.ms,
    });
  }

  // ————————————————————————————————————————————————
  // 演出
  // ————————————————————————————————————————————————

  #perform(spec) {
    this.#busyUntil = Date.now() + (spec.ms || 3000);
    this.#state.lastPerformance = { at: Date.now(), ...spec };
    this.#push({
      type: 'act',
      mood: spec.mood,
      motion: spec.motion,
      props: spec.props ?? [],
      line: spec.line,
      heart: spec.tier >= 2,
      ms: spec.ms,
      exclusive: spec.tier >= 4,
      tier: spec.tier,
    });
    for (const eff of spec.effects ?? []) {
      this.#push({ type: 'effect', name: eff.name, intensity: eff.intensity ?? 0.6, tier: spec.tier });
    }
    // 打赏也要出声：只补音频，气泡已经在上面的 act 里推过了
    if (spec.line) this.#voiceFor(spec.line).catch(() => {});
    log.info(`🎁 [T${spec.tier}] ${spec.line}`);
  }

  /**
   * 只出声，不出气泡。给"气泡已经单独推过"的场景用（比如打赏演出）。
   * 合成是异步的：慢一点没关系，反正气泡已经把话写出来了。
   */
  async #voiceFor(text) {
    // 只出声、不推气泡——气泡已经由 #perform 推过了
    this.#speaker.voiceOnly(text);
  }

  /**
   * 说一句话：**气泡立刻上屏**，语音合成好再补。
   *
   * 顺序很重要：如果等合成完再推气泡，合成一慢（受限环境 1.7s），
   * 观众会看到一只"沉默两秒然后突然开口"的鲸鱼。气泡先出、声音后到，
   * 观感上只是"她说话有点延迟"，而不是"她傻了"。
   */
  /**
   * 说一句话。**串行**：这句真的播完了才轮到下一句。
   * 返回的 promise 在这句话播完（或超时）后 resolve，游戏阶段可以直接 await。
   */
  async #speak(text, { ms, mood = 'happy', motion, priority = 'chat' } = {}) {
    this.#voiceSeq += 1;
    return this.#speaker.speak(text, { ms, mood, motion, priority }).then(() => ({ line: text }));
  }

  // ————————————————————————————————————————————————
  // 点歌
  // ————————————————————————————————————————————————

  async #handleSongRequest(ev, parsed) {
    const name = displayName(ev.user.name);
    const result = await this.#songs.request({ song: parsed.song, user: ev.user });

    if (!result.ok) {
      const line = SONG_LINES[result.reason] ?? '这首歌我现在还唱不了，换一首好不好';
      log.info(`💬 点歌被拒（${result.reason}）：${name}`);
      await this.#speak(line, { ms: 3000, mood: result.reason === 'no_credit' ? 'playful' : 'confused' });
      return;
    }

    this.#state.songs++;
    const who = result.requesters.length > 1 ? `${name}他们` : name;

    if (result.merged) {
      await this.#speak(`${who}都要听${result.song}，一起安排～`, { ms: 3000, mood: 'happy' });
    } else if (result.immediate) {
      await this.#speak(`${name}点的${result.song}，这就安排`, { ms: 3000, mood: 'excited' });
    } else {
      await this.#speak(`这首我还没学会，正在学，等我几分钟`, { ms: 3600, mood: 'thinking' });
    }
    this.#push({ type: 'song', status: 'accepted', id: result.id, song: result.song, user: name, position: result.position });
  }

  /** 点歌主循环：推进渲染 + 看有没有能播的。 */
  async #tickSongs() {
    if (!this.#running || !this.#songs || this.#cfg.songs?.enabled === false) return;

    // 渲染（慢），不阻塞播放
    const pumped = await this.#songs.pump();
    if (pumped?.status === 'failed') {
      await this.#speak('刚那首歌没做成，换一首好不好', { ms: 3000, mood: 'sad' });
    }

    await this.#maybePlaySong();
  }

  async #maybePlaySong() {
    if (!this.#audio || !this.#songs) return;
    if (this.#game?.active) return;
    if (this.#announcingId || this.#audio.busy) return;
    // 没有舞台在看就不开唱：没人听见的播放等于浪费一次渲染
    if (typeof this.#stage.hasClients === "function" && !this.#stage.hasClients()) return;

    const gap = this.#cfg.songs?.minGapMs ?? 90_000;
    if (this.#lastSongEndAt && Date.now() - this.#lastSongEndAt < gap) return;

    const item = this.#songs.nextReady();
    if (!item) return;

    this.#announcingId = item.id;
    try {
      await this.#songs.markAnnouncing(item.id);
      const names = (item.requesters ?? [{ name: item.requestedBy?.name ?? '观众' }]).map((r) => r.name);
      const who = names.length > 1 ? `${names.slice(0, 2).join('和')}等 ${names.length} 位` : names[0];
      // #speak 会等到这句话真的播完，所以这里不用再等一次
      await this.#speak(`接下来播放${who}点的${item.song}`, { ms: 2600, mood: 'excited', priority: 'game' });

      // 报幕和唱歌之间留白，像节目而不是连播
      const pauseMs = this.#cfg.songs?.gapAfterAnnounceMs ?? 1500;
      await new Promise((r) => setTimeout(r, pauseMs));

      await this.#songs.markPlaying(item.id);
      const ok = this.#audio.playMusic({
        id: item.id,
        file: item.file,
        durationMs: item.durationMs ?? 30_000,
      });
      if (!ok) {
        log.warn(`音乐通道被占用，${item.id} 稍后重试`);
        await this.#songs.requeue(item.id);
        return;
      }

      // 唱歌动作先占位：等新模型资源（举麦克风/音符）进来后换掉这个 motion
      this.#push({
        type: 'act',
        mood: 'happy',
        motion: this.#cfg.songs?.singMotion ?? 'aidale',
        line: '',
        ms: Math.min(item.durationMs ?? 20_000, 20_000),
        heart: false,
        tier: 3,
      });
      log.info(`🎵 播放 ${item.id}「${item.song}」给 ${who}`);
    } catch (err) {
      log.error('播放歌曲失败：', err);
      await this.#songs.markFailed(item.id, err?.message).catch(() => {});
    } finally {
      this.#announcingId = null;
    }
  }

  // ————————————————————————————————————————————————
  // 闲聊
  // ————————————————————————————————————————————————

  async #tickInteraction() {
    if (!this.#running || !this.#cfg.interaction.enabled) return;
    // 演出期间（打赏/关注）不插闲聊：观众掏了钱，那几秒画面就得是他的
    // 游戏进行中不插话：她自己要说提示
    if (this.#game?.active) return;
    if (Date.now() < this.#busyUntil || this.#queue.stats.pending > 0) return;
    // 唱歌时不插闲聊：观众点的是歌，不是来听她跟别人聊天的
    if (this.#audio?.busy) return;
    const picked = this.#selector.pick();
    if (!picked) return;
    if (picked.blocked) {
      log.debug(`暂不搭话：${picked.blocked}`);
      return;
    }

    const { ev, text } = picked;
    const out = await this.#brain.reply({
      intent: 'chat',
      text,
      user: ev.user,
      persona: this.#cfg.brain.persona,
      contextLine: `在线 ${this.#state.viewers} 人，刚有大额打赏 ${this.#state.diamonds} 抖币`,
    });

    this.#state.lastReply = { at: Date.now(), user: displayName(ev.user.name), ask: oneLine(text, 30), text: out.text, source: out.source };
    await this.#speak(out.text, { ms: 2800, mood: out.mood ?? 'happy' });
    this.#push({ type: 'reply', user: displayName(ev.user.name), ask: oneLine(text, 34), text: out.text, source: out.source });
    log.info(`💬 回 ${displayName(ev.user.name)}「${oneLine(text, 20)}」→ ${out.text}`);
  }

  // ————————————————————————————————————————————————
  // 手动触发（管控台）
  // ————————————————————————————————————————————————

  async manual(kind, payload = {}) {
    if (kind === 'event') {
      // 测试/回归用：把一个完整事件（gift/comment/...）原样喂进主管线，
      // 和真实推送走同一条路——这样统计、连击、演出、触发条件都会被覆盖到。
      const ev = payload.event;
      if (!ev || !ev.type) return { ok: false, reason: 'bad_event' };
      this.handle([{ ...ev, ts: ev.ts ?? Date.now() }]);
      return { ok: true, type: ev.type };
    }
    if (kind === 'gift') {
      const tier = Math.max(1, Math.min(5, Number(payload.tier) || 1));
      const diamonds = [1, 5, 50, 500, 5000][tier - 1];
      const spec = giftBehavior({ diamonds, name: payload.name ?? '测试观众', giftName: payload.gift ?? `测试礼物T${tier}`, count: payload.count ?? 1, seed: Date.now() });
      this.#queue.enqueue({ label: `manual-gift-${Date.now()}`, priority: 9, spec, durationMs: spec.ms });
      return { ok: true, tier };
    }
    if (kind === 'say') {
      const text = oneLine(payload.text ?? '测试一下', 40);
      await this.#speak(text, { ms: 3000, mood: payload.mood ?? 'happy' });
      return { ok: true, text };
    }
    if (kind === 'song') {
      const song = payload.song ?? '';
      const user = { id: payload.userId ?? 'manual-tester', name: payload.name ?? '测试观众' };
      if (payload.grant !== false && this.#songs) await this.#songs.grant(user.id, Number(payload.tier) || 4);
      const r = await this.#songs.request({ song, user });
      return { ok: r.ok, result: r };
    }
    if (kind === 'comment') {
      // 测试/演示用：注入一条观众弹幕，走和真实弹幕完全一样的路径
      const ev = make.comment(payload.user ?? { id: 'manual-viewer', name: '测试观众' }, payload.text ?? '', Date.now());
      this.handle([ev]);
      return { ok: true, text: payload.text ?? '' };
    }
    if (kind === 'game') {
      if (payload.action === 'stop') return this.#game.stop();
      const r = this.#game.start({ trigger: 'manual', giver: payload.giver ?? null });
      // 注意：不返回 word——揭晓前答案不该出现在管控台/接口里
      return r.ok ? { ok: true, mode: r.mode, category: r.category, length: r.length ?? (r.word ? Array.from(r.word).length : null) } : { ok: false, reason: r.reason };
    }
    if (kind === 'stopSong') {
      const stopped = this.#audio?.stopMusic();
      this.#push({ type: 'base', mood: 'neutral', props: [] });
      log.info(`手动停止播放：${stopped ?? '（本来就没在放）'}`);
      return { ok: true, stopped };
    }
    if (kind === 'clearSongs') {
      const n = await this.#songs?.clearQueue('手动清空');
      this.#audio?.stopMusic();
      log.info(`清空点歌队列：${n} 条`);
      return { ok: true, cleared: n };
    }
    if (kind === 'motion') {
      this.#push({ type: 'motion', name: payload.name ?? 'splash' });
      return { ok: true };
    }
    if (kind === 'effect') {
      this.#push({ type: 'effect', name: payload.name ?? 'confetti', intensity: 1 });
      return { ok: true };
    }
    if (kind === 'reset') {
      this.#push({ type: 'act', mood: 'neutral', line: '', ms: 600 });
      this.#push({ type: 'base', mood: 'neutral', props: [] });
      this.#audio?.stopMusic();
      return { ok: true };
    }
    return { ok: false, reason: '未知操作' };
  }
}
