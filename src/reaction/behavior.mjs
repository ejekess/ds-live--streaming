/**
 * 打赏 → 行为 的对照表。
 *
 * 这是整个插件「最要紧」的一张表：观众掏了钱，屏幕上必须有对应的反应。
 * 设计原则：
 *   · 档位越高，动作越「大」——从点头致谢到喷水、撒花、庆功；
 *   · 每一档都同时给出「动作 / 表情 / 特效 / 台词」，缺一样都会显得敷衍；
 *   · 台词全部带变量，能念出观众名字和礼物数，比干巴巴一句「谢谢」强。
 */
import { tierOf } from '../events.mjs';

/** 模型自带的动作组（assets/model/c_0120.model3.json 里的 Motions）。 */
export const MOTIONS = ['idle', 'aidale', 'selfie', 'selfieQuick', 'ketchup', 'openLid', 'bubble', 'splash'];

/**
 * 五档行为。
 * motion 用模型自带动作，mood 用 pet.js 的情绪词汇，effects 交给舞台特效层。
 */
const BY_TIER = {
  1: {
    motion: 'aidale',
    mood: 'happy',
    props: [],
    effects: [{ name: 'hearts', intensity: 0.35 }],
    ms: 2600,
    lines: ['谢谢{name}的{gift}，收到啦～', '{name}送的小心心，我收下啦', '诶嘿，{name}的心意收到了'],
  },
  2: {
    motion: 'selfieQuick',
    mood: 'love',
    props: [],
    effects: [{ name: 'hearts', intensity: 0.6 }],
    ms: 3200,
    lines: ['{name}给了{gift}，比心！', '哇，{name}的{gift}，好开心', '{name}最好了，谢谢{gift}'],
  },
  3: {
    motion: 'bubble',
    mood: 'excited',
    props: [],
    effects: [
      { name: 'bubbles', intensity: 0.7 },
      { name: 'stars', intensity: 0.4 },
    ],
    ms: 3800,
    lines: ['{name}的{gift}到啦，给你吹个泡泡', '收到{name}的{gift}，开心到冒泡'],
  },
  4: {
    motion: 'splash',
    mood: 'excited',
    props: ['whaleHat'],
    effects: [
      { name: 'splash', intensity: 1 },
      { name: 'confetti', intensity: 0.8 },
    ],
    ms: 4400,
    lines: ['{name}送了{gift}！我喷水给你看！', '哇——{name}的{gift}，看我的喷水！'],
  },
  5: {
    motion: 'splash',
    mood: 'love',
    props: ['whaleHat', 'stickerBow'],
    effects: [
      { name: 'fireworks', intensity: 1 },
      { name: 'confetti', intensity: 1 },
      { name: 'hearts', intensity: 1 },
    ],
    ms: 6000,
    lines: ['{name}的{gift}！今天最亮的鲸鱼是给你喷水的', '{name}这也太豪了，{gift}收下，全场喷水！'],
  },
};

/** 连击播报：达到这些数量时额外来一句，避免每 +1 都念一遍。 */
const COMBO_LINES = {
  3: '{name}的{gift}×{count}，连击了！',
  10: '{name}×{count}！这是要包场吗',
  52: '{name}×{count}，我记住你了',
  1314: '{name}×{count}，一生一世是吧',
};

const FOLLOW = {
  motion: 'aidale',
  mood: 'happy',
  props: [],
  effects: [{ name: 'stars', intensity: 0.5 }],
  ms: 2800,
  lines: ['谢谢{name}关注，以后常来玩呀', '{name}关注了我，好开心'],
};

function fill(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key === 'name') return ctx.name ?? '观众';
    if (key === 'gift') return ctx.giftName ?? '礼物';
    if (key === 'count') return String(ctx.count ?? 1);
    if (key === 'diamonds') return String(ctx.diamonds ?? 0);
    return `{${key}}`;
  });
}

function sample(arr, seed) {
  if (!arr || !arr.length) return '';
  const i = Math.abs(Math.floor((seed ?? Math.random() * 1e9))) % arr.length;
  return arr[i];
}

/**
 * 把一条打赏事件翻译成可执行的行为。
 *
 * @param {object} args
 * @param {number} args.diamonds  本次累计抖币
 * @param {string} args.name      观众昵称
 * @param {string} args.giftName  礼物名
 * @param {number} args.count     连击数
 * @param {number} [args.seed]    让同一场里的随机选择可复现
 */
export function giftBehavior({ diamonds, name, giftName, count, seed }) {
  const tier = tierOf(diamonds);
  const spec = BY_TIER[tier.tier] ?? BY_TIER[1];
  const line = fill(sample(spec.lines, seed), { name, giftName, count, diamonds });
  return {
    tier: tier.tier,
    tierKey: tier.key,
    motion: spec.motion,
    mood: spec.mood,
    props: spec.props,
    effects: spec.effects,
    ms: spec.ms,
    line,
    priority: tier.tier,
  };
}

/** 连击达到里程碑时的播报（不需要重复演动作，只要一句话）。 */
export function comboLine({ name, giftName, count }) {
  const milestone = Object.keys(COMBO_LINES)
    .map(Number)
    .filter((n) => count >= n)
    .sort((a, b) => b - a)[0];
  if (!milestone) return null;
  return fill(COMBO_LINES[milestone], { name, giftName, count });
}

export function followBehavior({ name, seed }) {
  return {
    tier: 1,
    tierKey: 'follow',
    motion: FOLLOW.motion,
    mood: FOLLOW.mood,
    props: FOLLOW.props,
    effects: FOLLOW.effects,
    ms: FOLLOW.ms,
    line: fill(sample(FOLLOW.lines, seed), { name }),
    priority: 2,
  };
}

/** 待机：没有事的时候保持自然，不要一直傻站着。 */
export const IDLE_MOODS = ['neutral', 'happy', 'neutral', 'thinking'];
