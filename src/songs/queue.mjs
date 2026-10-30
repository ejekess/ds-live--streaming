/**
 * 点歌队列：一条点歌请求从 "排上" 到 "播完" 的全部生命周期。
 *
 * 为什么不用消息队列：吞吐是"每分钟几首"，进程只有一个，部署在主播本人电脑上。
 * 引 Redis/RabbitMQ 等于多养一个服务、多一条排障链路，收益为零。
 * 但有一件事必须解决——**跑一首歌要几分钟，进程重启不能把点歌丢了**，
 * 所以是「内存队列 + JSON 原子落盘 + 启动时按状态恢复」。
 *
 * 状态机与恢复规则见 docs/设计-语音与点歌.md §8.2。
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../log.mjs';

const log = logger('songs:queue');

export const STATUS = {
  QUEUED: 'queued',
  RENDERING: 'rendering',
  READY: 'ready',
  ANNOUNCING: 'announcing',
  PLAYING: 'playing',
  DONE: 'done',
  FAILED: 'failed',
  REJECTED: 'rejected',
};

/** 合法跃迁表。不在表里的跃迁一律抛错，绝不静默——静默的状态错乱最难查。 */
const LEGAL = {
  queued: ['rendering', 'ready', 'failed', 'rejected'],
  rendering: ['ready', 'failed', 'queued'],
  ready: ['announcing', 'playing', 'failed'],
  announcing: ['playing', 'ready', 'failed'],
  playing: ['done', 'failed', 'ready'],
  done: [],
  failed: ['queued'],
  rejected: [],
};

const ACTIVE = new Set([STATUS.QUEUED, STATUS.RENDERING, STATUS.READY, STATUS.ANNOUNCING, STATUS.PLAYING]);

let seq = 0;
const newId = (now) => `s_${now.toString(36)}_${(++seq).toString(36)}`;

export class SongQueue {
  #file;
  #max;
  #clock;
  #items = [];
  #dedupeWindowMs;
  #maxRetries;
  #saveChain = Promise.resolve();

  constructor({ file, max = 5, clock = () => Date.now(), dedupeWindowMs = 5 * 60_000, maxRetries = 2 }) {
    this.#file = file;
    this.#max = max;
    this.#clock = clock;
    this.#dedupeWindowMs = dedupeWindowMs;
    this.#maxRetries = maxRetries;
  }

  static async open(opts) {
    const q = new SongQueue(opts);
    await q.#load();
    return q;
  }

  // ————————————————————— 持久化 —————————————————————

  async #load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    if (!existsSync(this.#file)) return;
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8'));
      this.#items = Array.isArray(raw.items) ? raw.items : [];
      this.#recover();
    } catch (err) {
      log.error('队列文件损坏，按空队列启动：', err);
      this.#items = [];
    }
  }

  /** 崩溃恢复：把"半路"的状态拉回可继续的状态（见文档 §8.2 恢复表）。 */
  #recover() {
    const changed = [];
    for (const item of this.#items) {
      if (item.status === STATUS.RENDERING) {
        item.retries = (item.retries ?? 0) + 1;
        if (item.retries > this.#maxRetries) {
          item.status = STATUS.FAILED;
          item.error = item.error ?? '重启时重试次数耗尽';
        } else {
          item.status = STATUS.QUEUED;
        }
        changed.push(item.id);
      } else if (item.status === STATUS.PLAYING || item.status === STATUS.ANNOUNCING) {
        // 歌可能只播了一半；重新播一遍比"续播"自然
        item.status = STATUS.READY;
        changed.push(item.id);
      }
    }
    if (changed.length) log.warn(`启动恢复 ${changed.length} 条点歌：${changed.join(', ')}`);
  }

  /** 原子写：先写 .tmp 再 rename，避免断电写出半个 JSON。 */
  async #save() {
    const snapshot = JSON.stringify({ version: 1, items: this.#items }, null, 2) + '\n';
    this.#saveChain = this.#saveChain
      .then(async () => {
        const tmp = `${this.#file}.tmp`;
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, this.#file);
      })
      .catch((err) => log.error('队列落盘失败：', err));
    return this.#saveChain;
  }

  // ————————————————————— 查询 —————————————————————

  get size() {
    return this.#items.filter((i) => ACTIVE.has(i.status)).length;
  }

  list() {
    return this.#items.map((i) => ({ ...i }));
  }

  find(id) {
    return this.#items.find((i) => i.id === id) ?? null;
  }

  /** 下一个该播的：ready 里优先级最高、且最早的。 */
  nextReady() {
    return (
      this.#items
        .filter((i) => i.status === STATUS.READY)
        .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))[0] ?? null
    );
  }

  /** worker 取一条：排队中优先级最高的。 */
  nextQueued() {
    return (
      this.#items
        .filter((i) => i.status === STATUS.QUEUED)
        .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))[0] ?? null
    );
  }

  // ————————————————————— 写入 —————————————————————

  /**
   * 入队。
   * @returns {{ok:true, id:string, position:number, merged:boolean, item:object} | {ok:false, reason:string}}
   */
  async request({ song, user, tier, priority = 1, source = 'library', file = null, durationMs = null }) {
    const now = this.#clock();

    // 去重：5 分钟内同一首歌已在队列里 → 合并请求人，不重复做
    const norm = String(song ?? '').toLowerCase();
    const dup = this.#items.find(
      (i) => ACTIVE.has(i.status) && String(i.song).toLowerCase() === norm && now - i.createdAt < this.#dedupeWindowMs,
    );
    if (dup) {
      if (!dup.requesters.some((r) => r.id === user.id)) {
        dup.requesters.push({ id: user.id, name: user.name });
      }
      await this.#save();
      return { ok: true, id: dup.id, position: this.#positionOf(dup), merged: true, item: { ...dup } };
    }

    if (this.size >= this.#max) return { ok: false, reason: 'queue_full' };

    const item = {
      id: newId(now),
      song,
      requesters: [{ id: user.id, name: user.name }],
      requestedBy: { id: user.id, name: user.name }, // 兼容/展示用，报幕念第一个
      tier,
      priority,
      source,
      status: file ? STATUS.READY : STATUS.QUEUED,
      file,
      durationMs,
      retries: 0,
      announcedAt: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      error: null,
    };

    this.#insert(item);
    await this.#save();
    return { ok: true, id: item.id, position: this.#positionOf(item), merged: false, item: { ...item } };
  }

  /** 按优先级插入：T5 一定排在所有 T3 前面。 */
  #insert(item) {
    let at = this.#items.length;
    for (let i = 0; i < this.#items.length; i++) {
      const cur = this.#items[i];
      if (!ACTIVE.has(cur.status)) continue;
      if (cur.priority < item.priority) {
        at = i;
        break;
      }
    }
    this.#items.splice(at, 0, item);
  }

  #positionOf(item) {
    const active = this.#items.filter((i) => ACTIVE.has(i.status));
    return active.findIndex((i) => i.id === item.id) + 1;
  }

  // ————————————————————— 状态跃迁 —————————————————————

  async #transition(id, to, patch = {}) {
    const item = this.find(id);
    if (!item) throw new Error(`找不到点歌记录 ${id}`);
    const allowed = LEGAL[item.status] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(`非法状态跃迁：${item.status} → ${to}（${id}）`);
    }
    item.status = to;
    Object.assign(item, patch);
    await this.#save();
    return item;
  }

  startRendering(id) {
    return this.#transition(id, STATUS.RENDERING, { startedAt: this.#clock() });
  }

  markReady(id, { file, durationMs }) {
    // 渲染完成可能从 rendering 来，也可能从 queued（曲库命中）直接来
    const item = this.find(id);
    if (!item) throw new Error(`找不到点歌记录 ${id}`);
    if (!['rendering', 'queued'].includes(item.status)) {
      throw new Error(`非法状态跃迁：${item.status} → ready（${id}）`);
    }
    item.status = STATUS.READY;
    item.file = file;
    item.durationMs = durationMs ?? null;
    item.finishedAt = this.#clock();
    item.error = null;
    return this.#save().then(() => ({ ...item }));
  }

  markAnnouncing(id) {
    return this.#transition(id, STATUS.ANNOUNCING, { announcedAt: this.#clock() });
  }

  markPlaying(id) {
    const item = this.find(id);
    if (!item) throw new Error(`找不到点歌记录 ${id}`);
    // announcing → playing 是常规路径；兼容直接从 ready 播（无报幕场景）
    if (item.status === STATUS.READY) {
      item.status = STATUS.PLAYING;
      item.startedAt = this.#clock();
      return this.#save().then(() => ({ ...item }));
    }
    return this.#transition(id, STATUS.PLAYING, { startedAt: this.#clock() });
  }

  markDone(id) {
    return this.#transition(id, STATUS.DONE, { finishedAt: this.#clock() });
  }

  markFailed(id, error) {
    const item = this.find(id);
    if (!item) return null;
    item.status = STATUS.FAILED;
    item.error = String(error ?? '未知错误');
    item.finishedAt = this.#clock();
    return this.#save().then(() => ({ ...item }));
  }

  /** 渲染超时/进程挂了：退回排队，等下一轮重试。 */
  async requeue(id) {
    const item = this.find(id);
    if (!item) return null;
    item.retries = (item.retries ?? 0) + 1;
    if (item.retries > this.#maxRetries) return this.markFailed(id, '重试次数耗尽');
    item.status = STATUS.QUEUED;
    await this.#save();
    return { ...item };
  }

  /** 把所有进行中的记录标成失败（管控台「清空队列」用）。 */
  async clearActive(reason = '手动清空') {
    let n = 0;
    for (const item of this.#items) {
      if (!ACTIVE.has(item.status)) continue;
      item.status = STATUS.FAILED;
      item.error = reason;
      item.finishedAt = this.#clock();
      n++;
    }
    if (n) await this.#save();
    return n;
  }

  /** 清理已完成/失败的记录，只保留最近 N 条用于审计。 */
  async prune(keep = 50) {
    const finished = this.#items.filter((i) => !ACTIVE.has(i.status));
    if (finished.length <= keep) return 0;
    const drop = new Set(finished.slice(0, finished.length - keep).map((i) => i.id));
    this.#items = this.#items.filter((i) => !drop.has(i.id));
    await this.#save();
    return drop.size;
  }

  snapshot() {
    const active = this.#items.filter((i) => ACTIVE.has(i.status));
    return {
      size: active.length,
      rendering: active.find((i) => i.status === STATUS.RENDERING)?.id ?? null,
      playing: active.find((i) => i.status === STATUS.PLAYING)?.id ?? null,
      items: active.map((i) => ({
        id: i.id,
        song: i.song,
        who: i.requestedBy?.name ?? '?',
        tier: i.tier,
        status: i.status,
        retries: i.retries,
      })),
    };
  }
}
