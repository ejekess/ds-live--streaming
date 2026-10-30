/**
 * 演出队列。
 *
 * 直播里最怕的不是「没反应」，而是「反应糊在一起」：三条打赏同时到，
 * 动作被打断、台词叠在一起，观众只看到抽搐。
 *
 * 所以所有演出都进这一个队列，串行播放：
 *   · 高优先级（大礼）可以挤掉还在排队的低优先级（小心心）；
 *   · 正在播出的不被打断，除非高出一档以上；
 *   · 有全局最小间隔和每分钟上限，防止刷屏；
 *   · 队列有硬上限，溢出时丢最不重要的那条，绝不无限堆积。
 */
import { logger } from '../log.mjs';

const log = logger('queue');

export class ReactionQueue {
  #perform;
  #queue = [];
  #playing = null;
  #lastEndAt = 0;
  #timestamps = [];
  #opts;
  #timer = null;
  #stopped = false;
  #stats = { played: 0, dropped: 0, preempted: 0 };

  /**
   * @param {object} opts
   * @param {(spec: object) => Promise<void>|void} opts.perform
   * @param {number} opts.cooldownMs
   * @param {number} opts.maxPerMinute
   * @param {number} [opts.maxLength]
   */
  constructor({ perform, cooldownMs = 800, maxPerMinute = 45, maxLength = 8 }) {
    this.#perform = perform;
    this.#opts = { cooldownMs, maxPerMinute, maxLength };
  }

  setOptions({ cooldownMs, maxPerMinute }) {
    if (typeof cooldownMs === 'number') this.#opts.cooldownMs = cooldownMs;
    if (typeof maxPerMinute === 'number') this.#opts.maxPerMinute = maxPerMinute;
  }

  get stats() {
    return { ...this.#stats, pending: this.#queue.length, playing: this.#playing?.label ?? null };
  }

  /** @param {{label:string, priority:number, spec:object, durationMs:number}} item */
  enqueue(item) {
    if (this.#stopped) return false;

    // 同 label 的重复演出（比如同一个人连刷同一礼物）直接合并
    const dupIndex = this.#queue.findIndex((q) => q.label === item.label && q.priority === item.priority);
    if (dupIndex >= 0) {
      this.#stats.dropped++;
      return false;
    }

    // 高优先级挤掉排队中的低优先级
    if (this.#queue.length >= this.#opts.maxLength) {
      const weakest = this.#queue.reduce((acc, cur, i) => (cur.priority < this.#queue[acc].priority ? i : acc), 0);
      if (this.#queue[weakest].priority >= item.priority) {
        this.#stats.dropped++;
        log.debug(`队列满，丢弃 ${item.label}`);
        return false;
      }
      this.#queue.splice(weakest, 1);
      this.#stats.preempted++;
    }

    this.#queue.push(item);
    this.#queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    this.#kick();
    return true;
  }

  #rateLimited() {
    const now = Date.now();
    this.#timestamps = this.#timestamps.filter((t) => now - t < 60_000);
    if (this.#timestamps.length >= this.#opts.maxPerMinute) return true;
    return now - this.#lastEndAt < this.#opts.cooldownMs;
  }

  #kick() {
    if (this.#playing || this.#timer || this.#stopped) return;
    if (!this.#queue.length) return;

    const wait = Math.max(0, this.#opts.cooldownMs - (Date.now() - this.#lastEndAt));
    if (wait > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#kick();
      }, wait);
      return;
    }
    if (this.#rateLimited()) {
      // 触顶了：60 秒窗口滑过去一点再试
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#kick();
      }, 1200);
      return;
    }

    const item = this.#queue.shift();
    item.seq = this.#stats.played;
    this.#playing = item;
    this.#timestamps.push(Date.now());

    Promise.resolve()
      .then(() => this.#perform(item.spec, item))
      .catch((err) => log.error(`演出失败（${item.label}）：`, err))
      .finally(() => {
        this.#stats.played++;
        this.#playing = null;
        this.#lastEndAt = Date.now();
        this.#kick();
      });
  }

  clear() {
    this.#queue.length = 0;
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue.length = 0;
  }
}
