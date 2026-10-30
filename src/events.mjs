/**
 * 直播间事件的统一形状。
 *
 * 抓取层（CDP / exec / mock / replay）各自吐不同格式，全部先归一化成这里的几种，
 * 后面的挑选、编排、演出只认这一个契约。换来源不影响任何下游逻辑。
 */

/**
 * @typedef {object} Viewer
 * @property {string} id          稳定身份（抖音 sec_uid / uid，缺失时退化到昵称哈希）
 * @property {string} name        昵称
 * @property {number} [level]     粉丝团等级 / 用户等级
 * @property {boolean} [isFan]    是否粉丝团
 * @property {boolean} [isAdmin]  是否房管
 * @property {boolean} [isAnchor] 是否主播自己
 *
 * @typedef {object} BaseEvent
 * @property {string} type
 * @property {string} id
 * @property {number} ts
 *
 * @typedef {BaseEvent & {type:'comment', user:Viewer, text:string}} CommentEvent
 * @typedef {BaseEvent & {type:'gift', user:Viewer, giftId:string, giftName:string, count:number, repeatEnd:boolean, unitDiamonds:number, totalDiamonds:number}} GiftEvent
 * @typedef {BaseEvent & {type:'like', user:Viewer|null, count:number, total:number}} LikeEvent
 * @typedef {BaseEvent & {type:'enter', user:Viewer}} EnterEvent
 * @typedef {BaseEvent & {type:'follow', user:Viewer}} FollowEvent
 * @typedef {BaseEvent & {type:'stats', viewers:number, likes:number}} StatsEvent
 *
 * @typedef {CommentEvent|GiftEvent|LikeEvent|EnterEvent|FollowEvent|StatsEvent} LiveEvent
 */

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`;

/** @returns {Viewer} */
export function viewer(input = {}) {
  const name = String(input.name ?? input.nickname ?? '观众').slice(0, 32) || '观众';
  return {
    id: String(input.id ?? input.uid ?? input.secUid ?? `name:${name}`),
    name,
    level: Number(input.level ?? input.fansClubLevel ?? 0) || 0,
    isFan: Boolean(input.isFan ?? input.fansClub ?? false),
    isAdmin: Boolean(input.isAdmin ?? false),
    isAnchor: Boolean(input.isAnchor ?? false),
  };
}

function base(type, ts) {
  return { type, id: nextId(type), ts: Number(ts) || Date.now() };
}

export const make = {
  comment: (user, text, ts) => ({ ...base('comment', ts), user: viewer(user), text: String(text ?? '') }),
  gift: (user, gift, ts) =>
    ({
      ...base('gift', ts),
      user: viewer(user),
      giftId: String(gift.id ?? gift.giftId ?? gift.name ?? 'unknown'),
      giftName: String(gift.name ?? gift.giftName ?? '礼物'),
      count: Math.max(1, Number(gift.count ?? 1) || 1),
      repeatEnd: gift.repeatEnd !== false,
      unitDiamonds: Math.max(0, Number(gift.diamonds ?? gift.unitDiamonds ?? gift.diamondCount ?? 0) || 0),
      totalDiamonds:
        Math.max(0, Number(gift.totalDiamonds ?? 0) || 0) ||
        Math.max(1, Number(gift.count ?? 1) || 1) * Math.max(0, Number(gift.diamonds ?? gift.unitDiamonds ?? gift.diamondCount ?? 0) || 0),
    }),
  like: (user, count, total, ts) => ({ ...base('like', ts), user: user ? viewer(user) : null, count: Number(count) || 1, total: Number(total) || 0 }),
  enter: (user, ts) => ({ ...base('enter', ts), user: viewer(user) }),
  follow: (user, ts) => ({ ...base('follow', ts), user: viewer(user) }),
  stats: (viewers, likes, ts) => ({ ...base('stats', ts), viewers: Number(viewers) || 0, likes: Number(likes) || 0 }),
};

/**
 * 打赏档位阶梯。金额单位是抖币（抖音礼物面板上的数字）。
 * 阶梯刻意做成 1 / 2-9 / 10-99 / 100-999 / 1000+，覆盖从「小心心」到「嘉年华」。
 */
export const TIERS = [
  { tier: 1, key: 'spark', label: '小心意', min: 0, max: 1 },
  { tier: 2, key: 'warm', label: '有份量', min: 2, max: 9 },
  { tier: 3, key: 'nice', label: '挺大方', min: 10, max: 99 },
  { tier: 4, key: 'big', label: '大礼', min: 100, max: 2999 },
  { tier: 5, key: 'royal', label: '重礼', min: 3000, max: Infinity },
];

/** @param {number} diamonds */
export function tierOf(diamonds) {
  const d = Math.max(0, Number(diamonds) || 0);
  for (const t of TIERS) if (d >= t.min && d <= t.max) return t;
  return TIERS[0];
}

/** 一条事件够不够格触发「演出」。点赞/进场之类默认不算。 */
export function isPerformable(ev) {
  return ev.type === 'gift' || ev.type === 'follow';
}
