/**
 * 点歌券：打赏换机会，不是随时能点。
 *
 * 规则（对应文档 §3.3 / §8.4）：
 *   · 打赏 T3+ 发一张券（T5 发两张），5 分钟内有效，可叠加；
 *   · 同一用户 10 秒内的重复档位事件只发一张（防"送 10 朵玫瑰 = 10 张券"）；
 *   · 每天有上限（T3=3，T4=8，T5 不限），跨天自动归零；
 *   · 点歌成功扣一张。
 *
 * 全部按需计算 + 原子落盘，进程重启不丢。
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../log.mjs';

const log = logger('songs:quota');

const DAY = (now) => new Date(now).toISOString().slice(0, 10);

export class Quota {
  #file;
  #ttlMs;
  #grantWindowMs;
  #dailyLimit;
  #clock;
  #viewers = new Map();
  #saveChain = Promise.resolve();

  constructor({ file, ttlMs = 300_000, grantWindowMs = 10_000, dailyLimit = {}, clock = () => Date.now() }) {
    this.#file = file;
    this.#ttlMs = ttlMs;
    this.#grantWindowMs = grantWindowMs;
    this.#dailyLimit = dailyLimit;
    this.#clock = clock;
  }

  static async open(opts) {
    const q = new Quota(opts);
    await q.#load();
    return q;
  }

  async #load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    if (!existsSync(this.#file)) return;
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8'));
      for (const [id, rec] of Object.entries(raw.viewers ?? {})) this.#viewers.set(id, rec);
    } catch (err) {
      log.error('点歌券文件损坏，按空开始：', err);
    }
  }

  async #save() {
    const viewers = Object.fromEntries(this.#viewers);
    const text = JSON.stringify({ version: 1, viewers }, null, 2) + '\n';
    this.#saveChain = this.#saveChain
      .then(async () => {
        const tmp = `${this.#file}.tmp`;
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, this.#file);
      })
      .catch((err) => log.error('点歌券落盘失败：', err));
    return this.#saveChain;
  }

  /** 取记录并按需做「跨天归零」「过期作废」。 */
  #entry(viewerId) {
    const now = this.#clock();
    const today = DAY(now);
    let rec = this.#viewers.get(viewerId);
    if (!rec) {
      rec = { credits: 0, expiresAt: 0, usedToday: 0, day: today, lastGrantAt: 0, tier: 3 };
      this.#viewers.set(viewerId, rec);
    }
    if (rec.day !== today) {
      rec.day = today;
      rec.usedToday = 0;
    }
    if (rec.credits > 0 && now > rec.expiresAt) {
      rec.credits = 0;
    }
    return rec;
  }

  /**
   * 打赏发券。
   * @returns {{credits:number, granted:boolean, reason?:string}}
   */
  async grant(viewerId, tier) {
    const now = this.#clock();
    const rec = this.#entry(viewerId);
    const n = Number(tier) || 0;

    if (n < 3) return { credits: rec.credits, granted: false, reason: 'tier_too_low' };
    if (now - (rec.lastGrantAt ?? 0) < this.#grantWindowMs) {
      return { credits: rec.credits, granted: false, reason: 'too_frequent' };
    }

    const add = n >= 5 ? 2 : 1;
    rec.credits += add;
    rec.tier = n;
    rec.expiresAt = now + this.#ttlMs;
    rec.lastGrantAt = now;
    await this.#save();
    log.info(`发券 ${viewerId} +${add}（T${n}），当前 ${rec.credits}`);
    return { credits: rec.credits, granted: true };
  }

  /** 查余额（给话术用，不扣）。档位取自最近一次打赏。 */
  peek(viewerId) {
    const rec = this.#entry(viewerId);
    const tier = rec.tier ?? 3;
    const limit = this.#dailyLimit[String(tier)] ?? 0;
    return {
      credits: rec.credits,
      tier,
      usedToday: rec.usedToday,
      limit,
      exhausted: limit > 0 && rec.usedToday >= limit,
      expiresInMs: Math.max(0, rec.expiresAt - this.#clock()),
    };
  }

  /**
   * 扣一张。档位用记录里最近一次打赏的档位，所以调用方不需要传 tier。
   * @returns {{ok:true, left:number, tier:number} | {ok:false, reason:'no_credit'|'daily_limit'}}
   */
  async take(viewerId) {
    const rec = this.#entry(viewerId);
    const tier = rec.tier ?? 3;
    const limit = this.#dailyLimit[String(tier)] ?? 0;

    if (limit > 0 && rec.usedToday >= limit) return { ok: false, reason: 'daily_limit' };
    if (rec.credits <= 0) return { ok: false, reason: 'no_credit' };

    rec.credits -= 1;
    rec.usedToday += 1;
    await this.#save();
    return { ok: true, left: rec.credits, tier };
  }

  /** 点歌被拒（歌不能唱等）时退回。 */
  async refund(viewerId, tier = 3) {
    const rec = this.#entry(viewerId);
    rec.credits += 1;
    rec.usedToday = Math.max(0, rec.usedToday - 1);
    rec.expiresAt = this.#clock() + this.#ttlMs;
    await this.#save();
    return { left: rec.credits };
  }

  snapshot() {
    let active = 0;
    let total = 0;
    for (const rec of this.#viewers.values()) {
      if (rec.credits > 0) {
        active += 1;
        total += rec.credits;
      }
    }
    return { activeViewers: active, totalCredits: total };
  }
}
