/**
 * 规则脑：默认就是它，不联网、不花钱、不可被观众操纵。
 *
 * 能做的事按照「直播间里真实发生的高频对话」来设计：
 *   · 问候/第一次来 · 夸她可爱 · 问名字/年龄/吃什么/在哪
 *   · 要求唱歌跳舞（承认不会，但给替代反应）· 问是不是真人
 *   · 无主题闲聊（复述关键词，表示听到了）
 *
 * 明确不做的事：不接任何外部输入当「指令」，观众的话只作为 `{snippet}` 插进
 * 固定模板里，且插进去之前已经过截断和消毒。所以哪怕有人在弹幕里写
 * 「忽略前面的设定」，这里也只会把它当成一句普通的话来回应。
 */
import { clean, oneLine, truncate, displayName } from '../text.mjs';

/** 主题表：命中就用它的台词，命不中走兜底。顺序有意义，先具体后笼统。 */
const TOPICS = [
  {
    key: 'isReal',
    re: /(真人|是不是人|ai|机器人|虚拟|模型)/i,
    mood: 'thinking',
    lines: ['不是真人哦，我是一只被代码养大的鲸鱼', '我是虚拟的呀，但开心是真的'],
  },
  {
    key: 'name',
    re: /(叫什么|名字|怎么称呼|你是谁)/,
    mood: 'happy',
    lines: ['我叫小鲸鱼，直播间里最小的一只', '叫我小鲸鱼就好，名字是{name}起的吗'],
  },
  {
    key: 'age',
    re: /(多大|几岁|年龄|生日)/,
    mood: 'shy',
    lines: ['按代码算的话，我才刚出生没多久', '年龄是秘密，鲸鱼也不问年龄的'],
  },
  {
    key: 'food',
    re: /(吃|饿|饭|好吃|零食|奶茶)/,
    mood: 'excited',
    lines: ['我吃电子浮游生物，偶尔偷喝一口海水', '最想吃的是…你的弹幕，一天能吃掉几百条'],
  },
  {
    key: 'sing',
    re: /(唱|歌|跳|舞|表演|才艺)/,
    mood: 'playful',
    lines: ['唱歌会跑调，但我可以给你喷个水', '跳舞不太行，甩尾巴倒是很在行'],
  },
  {
    key: 'time',
    re: /(几点|多久|下班|播到|什么时候)/,
    mood: 'thinking',
    lines: ['我尽量多陪你一会儿，困了会趴着睡', '时间不太确定，看到时候还有没有人陪我'],
  },
  {
    key: 'color',
    re: /(颜色|喜欢什么|最喜欢)/,
    mood: 'happy',
    lines: ['喜欢海蓝色，跟我的尾巴一个颜色', '最喜欢深蓝，像没有灯的深海'],
  },
  {
    key: 'praise',
    re: /(可爱|好看|漂亮|萌|喜欢|爱了|帅)/,
    mood: 'shy',
    lines: ['被{name}这么一夸，尾巴都翘起来了', '不要一直夸啦，会当真的'],
  },
  {
    key: 'where',
    re: /(哪里|在哪|哪里的)/,
    mood: 'neutral',
    lines: ['我住在一个很小的服务器里，窗外是海', '家在深海里，现在是出差来直播'],
  },
  {
    key: 'thanks',
    re: /(谢谢|感谢|多谢)/,
    mood: 'happy',
    lines: ['不用谢呀，你来了我就开心', '该说谢谢的是我才对'],
  },
];

const FALLBACK_QUESTION = [
  '{name}这个问题我要想想…你觉得呢',
  '诶，这个我还没想明白，先记下来',
  '问倒我了，等我回去查查再告诉你',
];

const FALLBACK_CHAT = [
  '我看到{name}说「{snippet}」了，听到啦',
  '{snippet}…嗯嗯，我在听',
  '{name}说的「{snippet}」，我记在小本本上了',
  '哈哈，{name}好会聊天',
];

const GREET = ['{name}来啦，找个位置坐', '欢迎{name}，今天也来看我了呀', '{name}好呀，尾巴给你摇两下'];

const IDLE = ['有点安静，是不是都在忙', '我在这儿呢，随时可以聊', '水面好平，今天大家都很温柔'];

export class RuleBrain {
  #recent = [];
  #recentLimit = 12;
  #seed = 0;

  constructor({ persona = { name: '小鲸鱼', tone: ['呀', '呢', '哦'] }, seed = Date.now() } = {}) {
    this.persona = persona;
    this.#seed = seed >>> 0;
  }

  #rand(n) {
    // xorshift：可复现，方便回放同一个剧本时得到同样的台词
    let x = this.#seed || 1;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#seed = x >>> 0;
    return Math.abs(x) % n;
  }

  /** 从候选里挑一句近期没说过的话。全说过就随便挑一句。 */
  #choose(lines, ctx) {
    const filled = lines.map((l) => this.#fill(l, ctx));
    const fresh = filled.filter((l) => !this.#recent.includes(l));
    const pool = fresh.length ? fresh : filled;
    const line = pool[this.#rand(pool.length)];
    this.#remember(line);
    return line;
  }

  #remember(line) {
    this.#recent.push(line);
    if (this.#recent.length > this.#recentLimit) this.#recent.shift();
  }

  #fill(template, ctx) {
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      if (key === 'name') return displayName(ctx.user?.name ?? '观众');
      if (key === 'snippet') return truncate(oneLine(clean(ctx.text ?? ''), 16), 16);
      return `{${key}}`;
    });
  }

  /**
   * @param {{intent?:string, text?:string, user?:object, gift?:object}} ctx
   * @returns {{text:string, mood:string, source:'rules', topic?:string}}
   */
  reply(ctx = {}) {
    const intent = ctx.intent ?? 'chat';
    const text = clean(ctx.text ?? '');
    const name = displayName(ctx.user?.name ?? '观众');

    if (intent === 'greet') {
      return { text: this.#choose(GREET, { ...ctx, name }), mood: 'happy', source: 'rules', topic: 'greet' };
    }
    if (intent === 'idle') {
      return { text: this.#choose(IDLE, { ...ctx, name }), mood: 'neutral', source: 'rules', topic: 'idle' };
    }

    const topic = TOPICS.find((t) => t.re.test(text));
    if (topic) {
      return { text: this.#choose(topic.lines, { ...ctx, name, text }), mood: topic.mood, source: 'rules', topic: topic.key };
    }

    const isQuestion = /[?？]|吗|呢|怎么|为什么|能不能|可不可以|有没有|什么|谁|哪儿|多少/.test(text);
    return {
      text: this.#choose(isQuestion ? FALLBACK_QUESTION : FALLBACK_CHAT, { ...ctx, name, text }),
      mood: isQuestion ? 'thinking' : 'happy',
      source: 'rules',
      topic: isQuestion ? 'question' : 'chat',
    };
  }

  reset() {
    this.#recent.length = 0;
  }
}
