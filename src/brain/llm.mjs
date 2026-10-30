/**
 * LLM 脑（可选，默认关闭）。
 *
 * 只在「规则脑已经决定要回这条」之后才被调用，也就是说：观众不能靠刷屏
 * 直接把调用量顶上去，调用量由挑选器控制，再由 Budget 封顶。
 *
 * 安全边界（和 guard.mjs 一起构成完整闭环）：
 *   · 输入先过 prepareInput（限长/去链接/注入粗筛），不通过就直接放弃；
 *   · 提示词里观众发言被明确包成数据块，指令区单独且靠前；
 *   · 响应有硬超时（AbortSignal），超时就当没说过；
 *   · 输出过 prepareOutput（去代码块/限长/拒绝元话术）；
 *   · 任何异常都返回 null，由调用方回退到规则脑——绝不把错误信息说给观众。
 */
import { Budget, prepareInput, prepareOutput, buildMessages } from './guard.mjs';
import { logger } from '../log.mjs';

const log = logger('llm');
const LAST_ERROR = Symbol('lastError');

export class LlmBrain {
  #opts;
  #budget;
  #disabledReason = '';
  #stats = { calls: 0, ok: 0, rejected: 0, failed: 0 };

  constructor(opts) {
    this.#opts = opts;
    this.#budget = new Budget({ maxCallsPerMinute: opts.maxCallsPerMinute, maxCallsPerDay: opts.maxCallsPerDay });
  }

  async init() {
    await this.#budget.load();
    const key = process.env[this.#opts.apiKeyEnv];
    if (!key) {
      this.#disabledReason = `未设置环境变量 ${this.#opts.apiKeyEnv}`;
      log.warn(`LLM 已开启但不可用：${this.#disabledReason}，将继续使用规则脑`);
    }
    return this;
  }

  get available() {
    return !this.#disabledReason && Boolean(process.env[this.#opts.apiKeyEnv]);
  }

  get stats() {
    return { ...this.#stats, budget: this.#budget.snapshot(), disabledReason: this.#disabledReason };
  }

  setLimits({ maxCallsPerMinute, maxCallsPerDay }) {
    this.#budget.setLimits({ maxCallsPerMinute, maxCallsPerDay });
  }

  /**
   * 猜词的决策：**结构化输出**。
   *
   * 和 reply() 的区别：聊天要灵活，所以返回自然语言；猜词只有两个动作，
   * 流程是定死的，让模型自由发挥等于把"该干嘛"交给概率。
   *
   * @param {{category:string, wordLength:number, history:Array, guesses:string[], forced:boolean}} ctx
   * @returns {Promise<{action:'ask'|'guess', guess:string|null, reason?:string}|null>}
   */
  async decide(ctx) {
    if (!this.available) return null;

    const budget = this.#budget.tryConsume('game');
    if (!budget.ok) {
      log.debug(`决策不发模型调用：${budget.reason}`);
      return null;
    }

    const lines = (ctx.history ?? [])
      .map((h, i) => `${i + 1}. ${h.question} → 大家说：${h.verdict?.text || '说法不一'}`)
      .join('\n');
    const said = (ctx.guesses ?? []).length ? `\n你已经猜过（都不对）：${ctx.guesses.join('、')}` : '';
    const rule = ctx.forced
      ? '这是最后一轮，**必须猜**，不能再问。'
      : '你有把握就猜，没把握就继续问。';

    const prompt = [
      '你在玩猜词游戏。观众知道答案，你只能靠提问来猜。',
      `类别：${ctx.category}　字数：${ctx.wordLength}`,
      '',
      '已知线索：',
      lines || '（还没有）',
      said,
      '',
      rule,
      '只输出一行 JSON，不要解释：',
      '{"action":"ask"}  或  {"action":"guess","guess":"两个字的词","reason":"一句理由"}',
    ].join('\n');

    this.#stats.calls++;
    try {
      const res = await fetch(this.#opts.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env[this.#opts.apiKeyEnv]}`,
        },
        body: JSON.stringify({
          model: this.#opts.model,
          messages: [
            { role: 'system', content: '你只输出一行 JSON，不写别的。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.6,
          max_tokens: 80,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
      if (!res.ok) {
        this.#stats.failed++;
        log.warn(`决策返回 ${res.status}`);
        return null;
      }
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content ?? '';
      if (raw) this.#stats.ok++;
      return raw || null;
    } catch (err) {
      this.#stats.failed++;
      log.warn('决策调用失败：', err?.message);
      return null;
    }
  }

  /**
   * @returns {Promise<{text:string, mood:string, source:'llm'}|null>} null 表示「这次别说话，交给规则脑」
   */
  async reply(ctx) {
    if (!this.available) return null;

    const input = prepareInput(ctx.text, { maxLen: 120 });
    if (!input.ok) {
      this.#stats.rejected++;
      log.debug(`丢弃一条不适合送模型的弹幕：${input.reason}`);
      return null;
    }

    const budget = this.#budget.tryConsume();
    if (!budget.ok) {
      log.debug(`不发模型调用：${budget.reason}`);
      return null;
    }

    const messages = buildMessages({
      persona: ctx.persona ?? { name: '小鲸鱼' },
      text: input.text,
      intent: ctx.intent,
      contextLine: ctx.contextLine,
    });

    this.#stats.calls++;
    const started = Date.now();
    try {
      const res = await fetch(this.#opts.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env[this.#opts.apiKeyEnv]}`,
        },
        body: JSON.stringify({
          model: this.#opts.model,
          messages,
          temperature: 0.8,
          // 输出长度在最源头就掐死：这里按 token 算，给 120 足够说一句话
          max_tokens: 120,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });

      if (!res.ok) {
        this.#stats.failed++;
        log.warn(`模型返回 ${res.status}`);
        return null;
      }

      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content ?? '';
      const line = prepareOutput(raw, { maxLen: this.#opts.maxOutputChars });
      if (!line) {
        this.#stats.rejected++;
        log.debug('模型输出未通过校验，丢弃');
        return null;
      }
      this.#stats.ok++;
      log.debug(`模型回话 ${Date.now() - started}ms：${line}`);
      return { text: line, mood: guessMood(line), source: 'llm' };
    } catch (err) {
      this.#stats.failed++;
      log.warn(`模型调用失败（${err?.name || 'error'}）：`, err?.message);
      return null;
    }
  }
}

/** 从一句话里粗略判断表情，够用就好，不用再花一次调用。 */
function guessMood(text) {
  if (/[?？]|想|不知道|为什么/.test(text)) return 'thinking';
  if (/开心|喜欢|太好了|棒|可爱/.test(text)) return 'happy';
  if (/谢谢|感动/.test(text)) return 'shy';
  if (/不要|不行|哼/.test(text)) return 'pout';
  return 'happy';
}
