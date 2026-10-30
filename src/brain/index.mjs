/**
 * 大脑工厂。
 *
 * 对外只暴露一个 `reply(ctx)`，内部决定走规则还是走模型。
 * 上层（编排器）不需要知道用的是哪个，也不需要处理「模型挂了怎么办」——
 * 这里的约定是：`reply()` 永远返回一句可以上屏的话，绝不抛异常。
 *
 * LLM 是**懒初始化**的：只有真的用到时才去读 Key、读预算文件。
 * 这样管控台里把 brain.kind 切成 llm 能立刻生效，不必重启进程；
 * 没配 Key 也只是这一条退回规则脑，不会开机就报错。
 */
import { RuleBrain } from './rules.mjs';
import { LlmBrain } from './llm.mjs';
import { logger } from '../log.mjs';

const log = logger('brain');

export async function createBrain(cfg) {
  const rules = new RuleBrain({ persona: cfg.brain.persona });
  // 注意：这里持有的是 cfg 的引用，管控台热改 brain.* 会直接改到这个对象
  const llm = new LlmBrain(cfg.brain.llm);
  let llmReady = false;
  let llmInitPromise = null;

  async function ensureLlm() {
    if (llmReady) return llm;
    if (!llmInitPromise) {
      llmInitPromise = llm
        .init()
        .then(() => {
          llmReady = true;
          return llm;
        })
        .catch((err) => {
          log.error('LLM 初始化失败，继续用规则脑：', err);
          return llm;
        });
    }
    await llmInitPromise;
    return llm;
  }

  async function reply(ctx) {
    const wantLlm = cfg.brain.kind === 'llm' && cfg.brain.llm.enabled;
    if (wantLlm) {
      try {
        const brain = await ensureLlm();
        const out = brain.available ? await brain.reply(ctx) : null;
        if (out) return out;
      } catch (err) {
        // 理论上 LlmBrain 自己已经兜住了，这里是最后一道保险
        log.error('LLM 脑异常，回退规则脑：', err);
      }
    }
    const local = rules.reply(ctx);
    return { ...local, source: 'rules' };
  }

  return {
    /**
     * 猜词决策（结构化输出）。规则脑没有推理能力 → 返回 null，游戏侧当"继续问"。
     * 模型不可用/超时/出错一律 null，调用方有兜底，不会卡住游戏。
     */
    decide: async (ctx) => {
      if (!(cfg.brain.kind === 'llm' && cfg.brain.llm.enabled)) return null;
      try {
        const brain = await ensureLlm();
        return await brain.decide(ctx);
      } catch (err) {
        log.warn('决策异常，当作继续问：', err?.message);
        return null;
      }
    },
    reply,
    stats() {
      return {
        kind: cfg.brain.kind,
        llmEnabled: cfg.brain.llm.enabled,
        llm: llmReady ? llm.stats : { ready: false, note: '尚未初始化（切到 llm 并启用后才会读取 Key 与预算）' },
      };
    },
    reset() {
      rules.reset();
    },
    setLimits(limits) {
      llm.setLimits(limits);
    },
  };
}
