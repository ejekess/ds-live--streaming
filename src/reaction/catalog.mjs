/**
 * 礼物目录。
 *
 * 正常情况下 `diamondCount` 会随礼物消息一起下来，不需要查表。
 * 但有三种情况必须兜底：
 *   · 某些互动礼物/盲盒的金额字段是 0；
 *   · 版本变化导致字段没填；
 *   · 观众送的是自定义礼物。
 * 所以留一份可编辑的 config/gifts.json，按「礼物名」或「礼物 id」查。
 *
 * 刻意没有内置一张「全网礼物价目表」——那种表抄来抄去、错一个数量级就会
 * 让大礼只触发小心心，反而更糟。缺的金额就按 0 处理，并在日志里点出来，
 * 由使用者自己补一条。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolved } from '../config.mjs';
import { tierOf } from '../events.mjs';
import { logger } from '../log.mjs';

const log = logger('gifts');

const DEFAULT_CATALOG = {
  '_说明': '按礼物名或礼物 id 补充抖币金额。diamondCount 正常会随消息下来，这里只是兜底。',
  '_示例': { '小心心': 1, '玫瑰': 1, '棒棒糖': 9, '甜甜圈': 52, '跑车': 1200, '嘉年华': 30000 },
};

export class GiftCatalog {
  #byName = new Map();
  #byId = new Map();
  #warned = new Set();

  async load(file, overrides = {}) {
    const abs = resolved(file);
    let raw = {};
    if (abs && existsSync(abs)) {
      try {
        raw = JSON.parse(await readFile(abs, 'utf8'));
      } catch (err) {
        log.error(`礼物目录解析失败（${abs}）：`, err);
      }
    }
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('_')) continue;
      const entry = typeof value === 'number' ? { diamonds: value } : value;
      if (!entry || typeof entry !== 'object') continue;
      if (/^\d+$/.test(key)) this.#byId.set(key, entry);
      else this.#byName.set(key, entry);
    }
    for (const [key, value] of Object.entries(overrides || {})) {
      const entry = typeof value === 'number' ? { diamonds: value } : value;
      if (/^\d+$/.test(key)) this.#byId.set(key, entry);
      else this.#byName.set(key, entry);
    }
    log.info(`礼物目录：${this.#byName.size} 个按名称、${this.#byId.size} 个按 id`);
    return this;
  }

  /** 补出金额和档位；金额为 0 且查不到时记一次日志，方便补表。 */
  resolve(ev) {
    const hit = this.#byId.get(String(ev.giftId)) || this.#byName.get(ev.giftName);
    const diamonds = ev.unitDiamonds || hit?.diamonds || 0;
    if (!diamonds && !this.#warned.has(ev.giftName)) {
      this.#warned.add(ev.giftName);
      log.warn(`礼物「${ev.giftName}」(id=${ev.giftId}) 没有金额，按最低档处理；可在 config/gifts.json 补一条。`);
    }
    return { diamonds, tier: tierOf(diamonds) };
  }

  async ensureFile(file) {
    const abs = resolved(file);
    if (existsSync(abs)) return;
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(resolved('config'), { recursive: true });
    await writeFile(abs, JSON.stringify(DEFAULT_CATALOG, null, 2) + '\n', 'utf8');
    log.info('已生成 config/gifts.json 模板');
  }
}
