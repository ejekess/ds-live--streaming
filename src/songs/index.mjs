/**
 * 点歌服务：把「券 / 门禁 / 曲库 / 队列 / 渲染」拼成一个入口。
 *
 * 上层（导演）只跟它打交道，不需要知道券从哪来、歌在哪、渲染走的哪条路。
 * 它自己也不说话、不播放——返回的是**原因码**，话术由导演决定，
 * 这样这个模块能被单测，而不用 mock 一个语音模块。
 */
import { logger } from '../log.mjs';
import { openLibrary } from './library.mjs';
import { SongQueue, STATUS } from './queue.mjs';
import { Quota } from './quota.mjs';
import { checkSong, routeSong, privilegesFor } from './gate.mjs';
import { createRenderer } from './render/index.mjs';

const log = logger('songs');

export async function createSongService(cfg, { clock = () => Date.now() } = {}) {
  const library = await openLibrary({
    libraryDir: cfg.libraryDir,
    stateDir: cfg.stateDir,
    rebuildIndex: cfg.rebuildIndex,
  });
  const queue = await SongQueue.open({ file: cfg.queueFile, max: cfg.maxQueue, clock });
  const quota = await Quota.open({
    file: cfg.quotaFile,
    ttlMs: cfg.creditTtlMs,
    grantWindowMs: cfg.grantWindowMs,
    dailyLimit: cfg.dailyLimit,
    clock,
  });
  const renderer = createRenderer({
    renderer: cfg.renderer,
    renderedDir: cfg.renderedDir,
    renderTimeoutMs: cfg.renderTimeoutMs,
    rvc: cfg.rvc,
    placeholder: cfg.placeholder,
  });

  /** 最近播过的歌名，给"随机"做规避。 */
  const recent = [];
  let rendering = false;

  /**
   * 点歌入口。返回原因码，不返回话术。
   * @returns {Promise<object>} 见下方 return
   */
  async function request({ song, user }) {
    if (!user?.id) return { ok: false, reason: 'no_user' };

    // —— 资格：先看券（只看不扣），档位取自最近一次打赏 ——
    const q = quota.peek(user.id);
    const priv = privilegesFor(q.tier);
    if (!priv.canSong) return { ok: false, reason: 'tier_too_low', tier: q.tier };
    if (q.exhausted) return { ok: false, reason: 'daily_limit', tier: q.tier, limit: q.limit };
    if (q.credits <= 0) return { ok: false, reason: 'no_credit', tier: q.tier };

    // —— 选歌：有歌名用歌名，没有就随机（避开最近几首） ——
    let target = song ? String(song).trim() : '';
    let random = false;
    if (!target) {
      const pick = library.random({ avoid: recent.slice(-(cfg.randomAvoidLast ?? 3)) });
      if (!pick) return { ok: false, reason: 'empty_library' };
      target = pick.name;
      random = true;
    }

    // —— 门禁（安全边界，不可推翻） ——
    const gate = checkSong(target, {
      maxLen: cfg.maxSongLen ?? 20,
      blacklist: cfg.blacklist ?? [],
      homophoneRules: cfg.homophoneRules ?? [],
    });
    if (!gate.ok) {
      log.warn(`拒绝点歌「${target}」：${gate.reason}${gate.detail ? ` (${gate.detail})` : ''}`);
      return { ok: false, reason: 'rejected', detail: gate.reason, tier: q.tier };
    }

    // —— 路由：曲库有就直接播，没有看档位允不允许现场渲染 ——
    const hit = library.find(target);
    const route = hit ? { action: 'play' } : routeSong({ inLibrary: false, tier: q.tier });
    if (route.action === 'reject') {
      return { ok: false, reason: 'not_in_library', song: target, tier: q.tier };
    }

    // —— 到这一步才真的扣券 ——
    const ticket = await quota.take(user.id);
    if (!ticket.ok) return { ok: false, reason: ticket.reason, tier: q.tier };

    const resolved = hit ? library.resolve(hit) : null;
    const result = await queue.request({
      song: resolved?.name ?? target,
      user,
      tier: ticket.tier,
      priority: priv.priority,
      source: resolved ? 'library' : 'render',
      file: resolved?.abs ?? null,
      durationMs: resolved?.durationMs ?? null,
    });

    if (!result.ok) {
      await quota.refund(user.id, ticket.tier);
      return { ok: false, reason: result.reason, tier: q.tier };
    }

    if (resolved) recent.push(resolved.name);
    if (recent.length > 20) recent.shift();

    return {
      ok: true,
      id: result.id,
      position: result.position,
      merged: result.merged,
      song: resolved?.name ?? target,
      random,
      immediate: Boolean(resolved),
      needRender: !resolved,
      requesters: result.item.requesters.map((r) => r.name),
    };
  }

  /**
   * worker：把排队中的渲染任务推进一步。
   * 单条串行——RVC 并发只会让两首都变慢，还会拖垮直播。
   */
  async function pump() {
    if (rendering) return null;
    const next = queue.nextQueued();
    if (!next) return null;

    // 曲库命中却还排队的（理论上不会发生），直接置 ready
    if (next.source === 'library' && next.file) {
      await queue.markReady(next.id, { file: next.file, durationMs: next.durationMs });
      return { id: next.id, status: STATUS.READY };
    }

    rendering = true;
    try {
      await queue.startRendering(next.id);
      const out = await renderer.render({ song: next.song });
      // 成品入库：下次点同一首直接秒播（这才是「曲库优先」闭环）
      const saved = await library.addCover({ name: next.song, file: out.file, durationMs: out.durationMs });
      await queue.markReady(next.id, { file: saved?.abs ?? out.file, durationMs: out.durationMs });
      log.info(`渲染完成 ${next.id}「${next.song}」`);
      return { id: next.id, status: STATUS.READY };
    } catch (err) {
      log.error(`渲染失败 ${next.id}「${next.song}」：`, err?.message);
      await queue.markFailed(next.id, err?.message);
      return { id: next.id, status: STATUS.FAILED, error: err?.message, song: next.song, user: next.requestedBy };
    } finally {
      rendering = false;
    }
  }

  return {
    // —— 读 ——
    nextReady: () => queue.nextReady(),
    snapshot() {
      return {
        renderer: renderer.kind,
        library: library.size,
        ...queue.snapshot(),
        quota: quota.snapshot(),
      };
    },
    library: () => library.list(),
    peekQuota: (userId, tier = 3) => quota.peek(userId, tier),
    findInLibrary: (name) => library.find(name),

    // —— 写 ——
    request,
    pump,
    grant: (viewerId, tier) => quota.grant(viewerId, tier),
    markAnnouncing: (id) => queue.markAnnouncing(id),
    markPlaying: (id) => queue.markPlaying(id),
    markDone: (id) => queue.markDone(id),
    markFailed: (id, err) => queue.markFailed(id, err),
    requeue: (id) => queue.requeue(id),
    prune: () => queue.prune(),
    clearQueue: (reason) => queue.clearActive(reason),

    isRendering: () => rendering,
  };
}
