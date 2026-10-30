/**
 * 统计：把直播间发生的事按天记账。
 *
 * 记什么：
 *   - 礼物：总次数、总抖币、按礼物、按观众、按档位
 *   - 互动：弹幕 / 点赞 / 进场 / 关注
 *   - 游戏：局数、轮数、投票人次、参与人数（去重）
 *
 * 为什么按天分桶：直播是「一场一场」的，跨天累计没有意义，
 * 但保留近 14 天又能看出趋势。写盘用「临时文件 + rename」，断电不会写坏。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './log.mjs';

const log = logger('stats');

const emptyDay = (date) => ({
  date,
  gifts: { count: 0, diamonds: 0, byGift: {}, byUser: {}, byTier: [0, 0, 0, 0, 0] },
  interactions: { comments: 0, likes: 0, enters: 0, follows: 0 },
  games: { count: 0, rounds: 0, votes: 0, forced: 0 },
  voters: [],
});

export function createStats({ clock = () => Date.now(), file = 'data/stats.json', keepDays = 14 } = {}) {
  /** @type {Map<string, ReturnType<typeof emptyDay>>} */
  const days = new Map();
  let loaded = false;
  let dirty = false;
  let timer = null;

  const dayKey = (t = clock()) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function day(t = clock()) {
    const k = dayKey(t);
    if (!days.has(k)) days.set(k, emptyDay(k));
    return days.get(k);
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      for (const d of raw.days ?? []) if (d?.date) days.set(d.date, { ...emptyDay(d.date), ...d });
    } catch {
      /* 第一次跑没有文件，正常 */
    }
  }

  async function flush() {
    if (!dirty) return;
    dirty = false;
    try {
      const list = [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, keepDays);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, days: list }, null, 2), 'utf8');
      await rename(tmp, file);
    } catch (err) {
      log.warn('统计写盘失败：', err?.message);
    }
  }

  function touch() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 1500);
    timer.unref?.();
  }

  return {
    load,
    flush,

    addGift({ user, giftName, diamonds = 0, tier = 1, count = 1 }) {
      const d = day();
      const total = diamonds * Math.max(1, count);
      d.gifts.count += 1;
      d.gifts.diamonds += total;

      const g = (d.gifts.byGift[giftName] ??= { count: 0, diamonds: 0 });
      g.count += 1;
      g.diamonds += total;

      const name = user?.name ?? '观众';
      const u = (d.gifts.byUser[name] ??= { count: 0, diamonds: 0 });
      u.count += 1;
      u.diamonds += total;

      const i = Math.min(4, Math.max(0, (tier ?? 1) - 1));
      d.gifts.byTier[i] += 1;
      touch();
    },

    addComment: () => { day().interactions.comments += 1; touch(); },
    addLike: (n = 1) => { day().interactions.likes += n; touch(); },
    addEnter: () => { day().interactions.enters += 1; touch(); },
    addFollow: () => { day().interactions.follows += 1; touch(); },

    addVote(viewerId) {
      if (!viewerId) return;
      const d = day();
      if (!d.voters.includes(viewerId)) d.voters.push(viewerId);
      touch();
    },

    addGame({ rounds = 0, votes = 0, forced = false } = {}) {
      const d = day();
      d.games.count += 1;
      d.games.rounds += rounds;
      d.games.votes += votes;
      if (forced) d.games.forced += 1;
      touch();
    },

    snapshot(t = clock()) {
      const today = day(t);
      const history = [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));

      const topGifts = Object.entries(today.gifts.byGift)
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.diamonds - a.diamonds || b.count - a.count)
        .slice(0, 8);

      const topUsers = Object.entries(today.gifts.byUser)
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.diamonds - a.diamonds || b.count - a.count)
        .slice(0, 8);

      const sum = (pick) => history.reduce((acc, d) => acc + pick(d), 0);

      return {
        today: {
          ...today,
          voters: today.voters.length,
        },
        topGifts,
        topUsers,
        history: history.map((d) => ({
          date: d.date,
          gifts: d.gifts.count,
          diamonds: d.gifts.diamonds,
          comments: d.interactions.comments,
          games: d.games.count,
          votes: d.games.votes,
          voters: d.voters.length,
        })),
        totals: {
          days: history.length,
          gifts: sum((d) => d.gifts.count),
          diamonds: sum((d) => d.gifts.diamonds),
          comments: sum((d) => d.interactions.comments),
          games: sum((d) => d.games.count),
          rounds: sum((d) => d.games.rounds),
          votes: sum((d) => d.games.votes),
        },
      };
    },
  };
}
