/**
 * 文本处理与消毒。
 *
 * 这个文件是「观众说的话」进入系统的唯一入口，所以它同时承担三件事：
 *   1. 上屏前把控制字符、零宽字符、超长内容清掉（防布局炸掉）；
 *   2. 交给大模型前再收一道（防提示注入、防超长烧 token）；
 *   3. 提供一批纯函数给规则引擎打分。
 * 刻意不做的事：不解析 HTML、不执行任何东西、不还原任何转义。
 */

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|cn|net|cc|top|xyz|vip|io)\b/gi;
const CONTACT = /(加|➕|➕|私)(微信|vx|wx|qq|群)|vx[:：]?\s*\w{4,}|wx[:：]?\s*\w{4,}/gi;

/** 去掉不可见/控制字符，统一空白。 */
export function clean(input) {
  return String(input ?? '')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00A0\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 按「字」截断（中文场景下 Array.from 比 slice 靠谱，至少不会切坏代理对）。 */
export function truncate(input, max) {
  const chars = Array.from(String(input ?? ''));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

export function visibleLength(input) {
  return Array.from(clean(input)).length;
}

/** 去掉链接和拉私域的话术。观众发这些多半不是来聊天的。 */
export function stripContact(input) {
  return String(input ?? '').replace(URLISH, '').replace(CONTACT, '').trim();
}

/**
 * 一屏只留一行：弹幕/字幕场景下换行没有意义，只会把气泡撑高。
 */
export function oneLine(input, max = 48) {
  return truncate(clean(input).replace(/\s*\n+\s*/g, ' '), max);
}

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
export function isEmojiOnly(input) {
  const s = clean(input);
  return s.length > 0 && EMOJI_ONLY.test(s);
}

/** 纯符号/纯标点，没有任何信息量。 */
export function isNoise(input) {
  const s = clean(input);
  if (!s) return true;
  return !/[\p{L}\p{N}]/u.test(s);
}

/**
 * 提示注入的粗筛。不做判定，只做标记——命中就降权或不送模型，
 * 但规则脑照样能正常回，不会因为「有人在钓鱼」就哑掉。
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|above)/i,
  /system\s*prompt/i,
  /忽略(上面|之前|以上|前面)?.{0,6}(指令|规则|设定|提示)/,
  /(你现在|从现在开始|接下来你)(是|扮演|作为)/,
  /输出(你的|所有的?)?(提示词|设定|system)/,
  /BEGIN\s+SYSTEM|END\s+SYSTEM|<\/?system>/i,
  /```|~~~/, // 代码块在直播字幕里没有意义，顺手当可疑
];

export function looksLikeInjection(input) {
  const s = clean(input);
  return INJECTION_PATTERNS.some((re) => re.test(s));
}

/**
 * 送进大脑（尤指大模型）之前的最后一道。
 * 长度硬上限 + 去链接 + 去控制字符，这三件事缺一不可：
 * 少了长度就会被「复制一千遍」类弹幕烧掉预算，少了去链接就可能被拿去当广告位。
 */
export function forBrain(input, { maxLen = 120 } = {}) {
  return truncate(stripContact(clean(input)), maxLen);
}

/** 输出侧：模型说什么都只当文本，压成一行、限长、去掉换行和反引号。 */
export function forSpeech(input, { maxLen = 48 } = {}) {
  return oneLine(String(input ?? '').replace(/[`*_#>]+/g, ''), maxLen);
}

export function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 昵称也要消毒：有人昵称里塞换行/控制字符，会把弹幕栏顶歪。 */
export function displayName(input, max = 16) {
  return truncate(clean(input).replace(/\s+/g, ' '), max) || '观众';
}
