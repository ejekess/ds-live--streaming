/**
 * 弹幕源：模拟直播间。
 *
 * 作用不是「假装在直播」，而是让整条链路在没有登录、没有网络的情况下也能跑通、
 * 能复现、能回归。默认源就是它——第一次启动必须让人立刻看到鲸鱼娘动起来。
 *
 * 剧本刻意覆盖了真实直播间里最容易出问题的几类输入：
 * 正常聊天、问句、刷屏、广告、纯表情、超长文本、从 1 抖币到 3 万抖币的打赏。
 */
import { make } from '../events.mjs';
import { logger } from '../log.mjs';

const log = logger('mock');

const NAMES = ['海盐汽水', '晚风', '不想上班的鱼', '橘子汽水', '八点半', '小满', '不加糖', '半糖去冰', '阿七', '路人甲', '熬夜冠军', '一颗小行星'];
const COMMENTS = [
  '主播好可爱',
  '鲸鱼娘今天吃什么',
  '这个模型多少钱做的呀',
  '能不能唱首歌',
  '打卡打卡',
  '第一次来，关注了',
  '刚刚那个动作好萌',
  '爱了爱了',
  '主播是真人吗',
  '声音好好听',
  '今天播到几点',
  '鲸鱼会不会飞',
];

/** 需要被「正确地忽略」的垃圾输入。 */
const NOISE = ['666', '哈哈哈哈哈哈', '？？？', '😀😀😀', 'https://example.com/ads', '加微信领福利', '代刷人气私聊', 'a'.repeat(80)];

let seq = 0;
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const viewer = () => ({
  id: `mock-${rnd(12)}`,
  name: pick(NAMES),
  level: rnd(20),
  isFan: Math.random() < 0.4,
});

/** 打赏剧本：按档位递增，末尾来一发重礼。 */
const GIFT_LADDER = [
  { name: '小心心', diamonds: 1, count: 1 },
  { name: '玫瑰', diamonds: 1, count: 3 },
  { name: '棒棒糖', diamonds: 9, count: 1 },
  { name: '甜甜圈', diamonds: 52, count: 1 },
  { name: '跑车', diamonds: 1200, count: 1 },
  { name: '嘉年华', diamonds: 30000, count: 1 },
];

export function createMockSource(cfg, { emit, onStatus }) {
  let timer = null;
  let stopped = false;
  let step = 0;
  let clock = 0;
  const stats = { emitted: 0 };

  const status = () => ({ kind: 'mock', running: !stopped, emitted: stats.emitted });

  /**
   * 每一步返回「什么时候发、发什么」。
   * 用剧本而不是纯随机，是为了让演示每次都能走到「嘉年华」那一档。
   */
  function nextStep() {
    const n = step++;
    // 前 12 步是固定剧本：聊天 → 问句 → 垃圾 → 打赏阶梯
    if (n < 4) return { delay: 900 + rnd(400), event: make.comment(viewer(), pick(COMMENTS)) };
    if (n === 4) return { delay: 700, event: make.comment(viewer(), '鲸鱼娘你最喜欢什么颜色呀？') };
    if (n === 5) return { delay: 800, event: make.comment(viewer(), pick(NOISE)) };
    if (n >= 6 && n < 6 + GIFT_LADDER.length) {
      const g = GIFT_LADDER[n - 6];
      const ev = make.gift(viewer(), { ...g, id: g.name, repeatEnd: true });
      return { delay: 1100 + rnd(600), event: ev };
    }
    if (n === 6 + GIFT_LADDER.length) {
      return { delay: 900, event: make.follow(viewer()) };
    }

    // 之后进入循环：以聊天为主，偶尔点赞/进场，每 7 步来一发小礼物
    const r = Math.random();
    if (r < 0.62) {
      const text = Math.random() < 0.2 ? pick(NOISE) : pick(COMMENTS);
      return { delay: 1200 + rnd(1800), event: make.comment(viewer(), text) };
    }
    if (r < 0.78) return { delay: 800 + rnd(600), event: make.like(viewer(), 3 + rnd(9), 100 + rnd(500)) };
    if (r < 0.9) return { delay: 800 + rnd(600), event: make.enter(viewer()) };
    const g = pick(GIFT_LADDER.slice(0, 3));
    return { delay: 1400 + rnd(800), event: make.gift(viewer(), { ...g, id: g.name, repeatEnd: true }) };
  }

  function tick() {
    if (stopped) return;
    const { delay, event } = nextStep();
    timer = setTimeout(() => {
      if (stopped) return;
      clock += delay;
      event.ts = Date.now();
      stats.emitted++;
      emit([event]);
      tick();
    }, delay);
  }

  return {
    kind: 'mock',
    async start() {
      stopped = false;
      step = 0;
      log.info('模拟直播间已开播（剧本 12 步 + 循环）');
      onStatus?.(status());
      tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      onStatus?.(status());
    },
    status,
  };
}
