/**
 * 事件总线：把「抓到的直播事件」和「对外的运行状态」分两路广播。
 *
 * 用 Node 自带 EventEmitter 就够了，但包一层是为了两件事：
 *   · 任何监听器抛错都不能弄死整条链路（直播中一个 bug 不该让上播断掉）；
 *   · 保留最近 N 条，管控台连上来时可以立刻补看上下文。
 */
import { EventEmitter } from 'node:events';
import { logger } from './log.mjs';

const log = logger('bus');

export class Bus {
  #emitter = new EventEmitter();
  #recent = [];
  #limit;
  #counts = {};

  constructor({ limit = 300 } = {}) {
    this.#emitter.setMaxListeners(50);
    this.#limit = limit;
  }

  on(type, fn) {
    this.#emitter.on(type, fn);
    return () => this.#emitter.off(type, fn);
  }

  /** 广播一条事件；返回实际投递的监听器数量，方便判断有没有人接。 */
  emit(type, payload) {
    const envelope = { type, ts: Date.now(), payload };
    this.#counts[type] = (this.#counts[type] || 0) + 1;
    this.#recent.push(envelope);
    if (this.#recent.length > this.#limit) this.#recent.splice(0, this.#recent.length - this.#limit);

    const listeners = this.#emitter.listeners(type);
    for (const fn of listeners) {
      try {
        fn(payload, envelope);
      } catch (err) {
        log.error(`监听器出错（${type}）：`, err);
      }
    }
    // 通配监听（管控台只挂一个）
    for (const fn of this.#emitter.listeners('*')) {
      try {
        fn(payload, envelope);
      } catch (err) {
        log.error(`通配监听器出错：`, err);
      }
    }
    return listeners.length;
  }

  recent(limit = 100) {
    return this.#recent.slice(-limit);
  }

  counts() {
    return { ...this.#counts };
  }
}
