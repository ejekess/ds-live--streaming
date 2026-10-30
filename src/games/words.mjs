/**
 * 内置词库。
 *
 * 设计原则：
 *   1. **按类别分组**——问题要贴着东西问。问「地铁」"能吃吗"虽然能答，但很傻。
 *      分类不是为了算信息增益（那套太复杂），只是为了「抽题时能抽到像样的题」。
 *   2. 每个词只写 1 条"专属提示"，其余靠类别通用提示补——省一半维护量，
 *      而且通用提示天然不含具体字，被过滤掉的概率低。
 *   3. 不写干扰项：干扰项按「同类别 + 同字数 + 首字不同」自动生成。
 */

/**
 * 类别 → 通用提示。这些句子刻意不含任何具体名词，所以对同类别所有词都安全。
 * （仍然会过一遍禁用字校验，个别词命中就自动跳过。）
 */
export const CATEGORY_HINTS = {
  水果: ['它是一种水果', '可以生吃', '超市里论斤卖'],
  食物: ['它是一种吃的', '一般在饭桌上出现', '要花钱买'],
  动物: ['它是一种动物', '电视上经常出现', '有自己的名字'],
  家电: ['它是家里用的', '要通电才能用', '身上有开关'],
  物品: ['它是一种日用品', '家里一般都找得到', '用久了会坏'],
  家具: ['它是摆在家里的大件', '搬起来很费劲', '每天都会碰到'],
  交通: ['它和出门有关', '在外面能见到', '要花钱才能用'],
  自然: ['它是自然现象', '抬头就能看到', '看不见也摸不到'],
};

/** @type {{word:string, category:keyof typeof CATEGORY_HINTS, hint:string}[]} */
export const WORDS = [
  // —— 水果 ——
  { word: '西瓜', category: '水果', hint: '外皮是绿的，切开是红的' },
  { word: '苹果', category: '水果', hint: '红红的圆圆的，咬一口很脆' },
  { word: '香蕉', category: '水果', hint: '弯弯的，要剥皮' },
  { word: '葡萄', category: '水果', hint: '一颗一颗串在一起' },
  { word: '橘子', category: '水果', hint: '要剥皮，掰开一瓣一瓣' },
  { word: '草莓', category: '水果', hint: '小小的，上面有籽' },
  { word: '菠萝', category: '水果', hint: '外面有刺，要泡盐水' },
  { word: '桃子', category: '水果', hint: '毛茸茸的，中间有核' },

  // —— 食物 ——
  { word: '蛋糕', category: '食物', hint: '过生日的时候端出来' },
  { word: '火锅', category: '食物', hint: '一群人围着煮东西吃' },
  { word: '包子', category: '食物', hint: '白白的，里面有馅' },
  { word: '冰淇淋', category: '食物', hint: '很冰，天热的时候吃' },
  { word: '面条', category: '食物', hint: '长长的，要用筷子吸' },
  { word: '汉堡', category: '食物', hint: '两片面包夹着肉' },

  // —— 动物 ——
  { word: '熊猫', category: '动物', hint: '国宝，黑白两色' },
  { word: '蝴蝶', category: '动物', hint: '翅膀很好看，停在花上' },
  { word: '企鹅', category: '动物', hint: '住在很冷的地方，走路摇摆' },
  { word: '金鱼', category: '动物', hint: '养在玻璃缸里' },
  { word: '兔子', category: '动物', hint: '耳朵很长，爱吃胡萝卜' },
  { word: '蜜蜂', category: '动物', hint: '会蜇人，采花做甜的东西' },

  // —— 家电 ——
  { word: '冰箱', category: '家电', hint: '厨房里站着，里面很冷' },
  { word: '空调', category: '家电', hint: '挂在墙上，夏天离不开' },
  { word: '洗衣机', category: '家电', hint: '会把脏的变干净' },
  { word: '遥控器', category: '家电', hint: '总在沙发缝里找不到' },
  { word: '台灯', category: '家电', hint: '放在桌上，晚上开' },
  { word: '微波炉', category: '家电', hint: '热饭很快，会转' },

  // —— 物品 ——
  { word: '手机', category: '物品', hint: '每天都要看，装在口袋里' },
  { word: '雨伞', category: '物品', hint: '撑开是圆的，收起来一根棍' },
  { word: '眼镜', category: '物品', hint: '戴在脸上，有两片' },
  { word: '口罩', category: '物品', hint: '挡住嘴和鼻子，有两根绳' },
  { word: '闹钟', category: '物品', hint: '早上会叫醒你' },
  { word: '橡皮', category: '物品', hint: '写错了才想起它' },
  { word: '气球', category: '物品', hint: '会飘，一戳就破' },
  { word: '钥匙', category: '物品', hint: '出门必须带，很小' },

  // —— 家具 ——
  { word: '沙发', category: '家具', hint: '客厅里，躺着最舒服' },
  { word: '衣柜', category: '家具', hint: '里面挂着很多布做的' },
  { word: '椅子', category: '家具', hint: '有四条腿，用来坐' },

  // —— 交通 ——
  { word: '地铁', category: '交通', hint: '在隧道里跑，一站一站停' },
  { word: '公交车', category: '交通', hint: '有固定路线，很多人挤' },
  { word: '自行车', category: '交通', hint: '要自己蹬，两个轮子' },
  { word: '红绿灯', category: '交通', hint: '路口站着，三种颜色轮流亮' },

  // —— 自然 ——
  { word: '太阳', category: '自然', hint: '白天挂在天上，很亮很热' },
  { word: '月亮', category: '自然', hint: '晚上才出来，会变圆变缺' },
  { word: '彩虹', category: '自然', hint: '雨停之后才出现，七种颜色' },
  { word: '雪', category: '自然', hint: '冬天从天上落下来，很白' },
];

const norm = (s) => String(s ?? '').replace(/[\s\u3000]/g, '');

export function bannedCharsOf(word) {
  return Array.from(norm(word));
}

export function hintIsSafe(hint, banned) {
  const h = norm(hint);
  return !banned.some((ch) => h.includes(ch));
}

/** 类别列表（抽取用）。 */
export const CATEGORIES = Object.keys(CATEGORY_HINTS);

export function pickWord({ avoid = [], category = null, random = Math.random } = {}) {
  const avoidSet = new Set(avoid.map((w) => norm(w)));
  let pool = WORDS.filter((w) => !avoidSet.has(norm(w.word)));
  if (category) {
    const inCat = pool.filter((w) => w.category === category);
    if (inCat.length) pool = inCat;
  }
  if (!pool.length) pool = WORDS;
  return pool[Math.floor(random() * pool.length)];
}

/**
 * 生成提示序列：专属提示 + 类别通用提示 + 兜底。
 * 每一条都过禁用字校验，不合格就跳过。
 */
export function buildHints(entry, { count = 3 } = {}) {
  const banned = bannedCharsOf(entry.word);
  const candidates = [
    entry.hint,
    ...(CATEGORY_HINTS[entry.category] ?? []),
    '这个大家肯定都见过',
    '它就在我们身边',
    '再想想，很常见的',
  ].filter(Boolean);

  const out = [];
  for (const c of candidates) {
    if (out.length >= count) break;
    if (!hintIsSafe(c, banned)) continue;
    if (out.includes(c)) continue;
    out.push(c);
  }
  return out;
}

/**
 * 四个选项：正确答案 + 同类别、同字数、首字不同的干扰项。
 * 不再手写 decoys——从词库自动挑。
 */
export function buildOptions(entry, { random = Math.random, count = 4, words = WORDS } = {}) {
  const answer = entry.word;
  const len = Array.from(norm(answer)).length;

  const sameLen = words.filter(
    (w) =>
      Array.from(norm(w.word)).length === len &&
      norm(w.word) !== norm(answer) &&
      norm(w.word)[0] !== norm(answer)[0],
  );

  // 优先同类别，不够再放宽
  const preferred = sameLen.filter((w) => w.category === entry.category);
  const pool = [...preferred, ...sameLen.filter((w) => w.category !== entry.category)];

  const picked = [];
  const bag = [...pool];
  while (picked.length < count - 1 && bag.length) {
    picked.push(bag.splice(Math.floor(random() * bag.length), 1)[0].word);
  }

  const list = [answer, ...picked].slice(0, count);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list.map((text, i) => ({ key: 'ABCD'[i], text, correct: norm(text) === norm(answer) }));
}
