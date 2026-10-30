/**
 * 连击追踪。
 *
 * 抖音的礼物连击不是「一次一条」：同一个礼物在连击期间会连续推多条，
 * `repeatCount` 是累计值而不是增量。如果每条都演一次，画面会疯；如果只在
 * 最后一条演，前面刷的又显得没人搭理。
 *
 * 这里的策略：
 *   · 累计值取 max，不累加（避免把 6 连算成 1+2+3+4+5+6=21）；
 *   · 连击结束（repeatEnd）一定演出；
 *   · 途中只在上里程碑（3/10/52/1314）时额外播报一句；
 *   · 大额礼物不等连击，立刻演出。
 */
import { logger } from '../log.mjs';

const log = logger('combo');

export class ComboTracker {
  #windowMs;
  #announceAt;
  #entries = new Map();
  #sweeper;

  constructor({ windowMs = 4500, announceAt = [3, 10, 52, 1314] } = {}) {
    this.#windowMs = windowMs;
    this.#announceAt = [...announceAt].sort((a, b) => a - b);
    this.#sweeper = setInterval(() => this.#sweep(), 10_000);
    this.#sweeper.unref?.();
  }

  setWindow(ms) {
    this.#windowMs = ms;
  }

  /**
   * @returns {{perform:boolean, milestone:number|null, count:number, diamonds:number, isNew:boolean}}
   */
  add(ev) {
    const key = `${ev.user.id}|${ev.giftId}`;
    const now = ev.ts || Date.now();
    let entry = this.#entries.get(key);

    if (!entry || now - entry.lastAt > this.#windowMs) {
      entry = { count: 0, unit: 0, firstAt: now, lastAt: now, lastMilestone: 0, giftName: ev.giftName };
      this.#entries.set(key, entry);
    }

    entry.lastAt = now;
    entry.count = Math.max(entry.count, ev.count);
    entry.unit = ev.unitDiamonds || entry.unit;
    entry.giftName = ev.giftName;

    const diamonds = entry.count * entry.unit;
    const milestone = [...this.#announceAt].reverse().find((n) => entry.count >= n && n > entry.lastMilestone) ?? null;
    if (milestone) entry.lastMilestone = milestone;

    // 大户礼物不等连击结束，立刻给反应
    const bigEnough = diamonds >= 100;
    const perform = Boolean(ev.repeatEnd) || milestone !== null || bigEnough;

    if (ev.repeatEnd) {
      this.#entries.delete(key);
    } else if (perform) {
      // 已经演过了，把里程碑记下，避免下一条重复播报同一个里程碑
      entry.lastMilestone = milestone ?? entry.lastMilestone;
    }

    return { perform, milestone, count: entry.count, diamonds, isNew: entry.count === ev.count };
  }

  #sweep() {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastAt > this.#windowMs * 4) {
        log.debug(`连击超时清理 ${key}`);
        this.#entries.delete(key);
      }
    }
  }

  stop() {
    clearInterval(this.#sweeper);
    this.#entries.clear();
  }
}
