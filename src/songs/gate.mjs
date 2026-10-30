/**
 * 门禁：两件事——这个人有没有资格点歌、这首歌能不能唱。
 *
 * 全部是纯函数，不碰文件、不碰网络。为什么单独拆出来：
 *   · 「没资格」和「歌不能唱」是两种失败，对应两句完全不同的话术
 *     （"先送我个甜甜圈呀" vs "这首我不太敢唱"），混在一起会互相污染；
 *   · 安全边界不能交给模型或概率——这里返回 ok:false 就是不可推翻的。
 */

/** 档位权益。严格对应，不跨级。 */
export const PRIVILEGES = {
  1: { canSong: false, allowRender: false, priority: 0, dailyLimit: 0 },
  2: { canSong: false, allowRender: false, priority: 0, dailyLimit: 0 },
  3: { canSong: true, allowRender: false, priority: 1, dailyLimit: 3 },
  4: { canSong: true, allowRender: true, priority: 2, dailyLimit: 8 },
  5: { canSong: true, allowRender: true, priority: 3, dailyLimit: 0 }, // 0 = 不限
};

export function privilegesFor(tier) {
  return PRIVILEGES[Math.max(1, Math.min(5, Number(tier) || 1))];
}

const CJK = /[\u4e00-\u9fff]/;
const ALLOWED = /^[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9 ·・&\-—_（）()【】\[\]《》'’.]+$/u;

/** 归一化：去掉空白和标点、转小写，用于黑名单/谐音匹配。 */
export function normalizeSongName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 歌名能不能唱。
 * @param {string} name
 * @param {{maxLen?:number, blacklist?:string[], homophoneRules?:{pattern:string, reason?:string}[]}} opts
 * @returns {{ok:true} | {ok:false, reason:string, detail?:string}}
 */
export function checkSong(name, opts = {}) {
  const raw = String(name ?? '').trim();
  const maxLen = opts.maxLen ?? 20;

  if (!raw) return { ok: false, reason: 'empty' };
  if (Array.from(raw).length > maxLen) return { ok: false, reason: 'too_long' };
  if (!CJK.test(raw) && !/[A-Za-z]/.test(raw)) return { ok: false, reason: 'no_letters' };
  if (!ALLOWED.test(raw)) return { ok: false, reason: 'bad_chars' };

  const norm = normalizeSongName(raw);

  for (const word of opts.blacklist ?? []) {
    const w = normalizeSongName(word);
    if (w && norm.includes(w)) return { ok: false, reason: 'blacklist', detail: word };
  }

  for (const rule of opts.homophoneRules ?? []) {
    const p = normalizeSongName(rule.pattern ?? '');
    if (p && norm.includes(p)) return { ok: false, reason: 'homophone', detail: rule.pattern };
  }

  return { ok: true };
}

/**
 * 这首歌在这个档位下该怎么处理。
 * @returns {{action:'play'|'render'|'reject', reason?:string}}
 */
export function routeSong({ inLibrary, tier }) {
  if (inLibrary) return { action: 'play' };
  if (privilegesFor(tier).allowRender) return { action: 'render' };
  return { action: 'reject', reason: 'not_in_library' };
}
