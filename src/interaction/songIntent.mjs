/**
 * 点歌意图识别：一句话 → 是不是点歌、歌名是什么。
 *
 * 纯函数，无 IO、无网络、无模型。整个交互链路里唯一"免费且 100% 可预测"的一步。
 *
 * 设计要点：
 *   · 先排除疑问句——"你会唱歌吗"是提问不是点歌，误触发一次就会让观众困惑；
 *   · 允许不带歌名（"来一首"→ 随机），这是刻意支持的；
 *   · 不做语义理解。宁可漏（当普通聊天），不可错（硬塞一首歌）。
 */

/** 触发词。按长度从长到短，避免"点歌"被"点"抢先匹配。 */
const TRIGGERS = ['点一首', '点首歌', '唱一首', '来一首', '点歌', '点首', '唱首', '唱个', '来首'];

/** 疑问信号：出现这些就不当成指令。 */
const QUESTION = /[?？]|吗|呢|会不会|能不能|可不可以|可以吗|好不好|行不行|怎样|如何/;

/** 允许的歌名前后缀噪声。 */
const NOISE = /^[\s:：,，、。.!！~～-]+|[\s:：,，、。.!！~～-]+$/g;

/**
 * @param {string} raw
 * @returns {{isRequest:boolean, song:string|null, trigger?:string, reason?:string}}
 */
export function parseSongRequest(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { isRequest: false, song: null, reason: '空' };
  if (text.length > 80) return { isRequest: false, song: null, reason: '过长' };

  if (QUESTION.test(text)) {
    return { isRequest: false, song: null, reason: '疑问句' };
  }

  for (const trigger of TRIGGERS) {
    const at = text.indexOf(trigger);
    if (at < 0) continue;

    // 触发词必须在句首附近（允许"主播点歌 xxx"这种前缀，但不允许夹在长句中间）
    if (at > 6) continue;

    let rest = text.slice(at + trigger.length).replace(NOISE, '').trim();

    // 常见后缀："吧"/"呗"/"好不好" 已经被疑问词拦掉了，这里只清语气词
    rest = rest.replace(/[吧呗呀啊哦嘛]+$/u, '').trim();

    if (!rest) return { isRequest: true, song: null, trigger, reason: '未指定歌名' };
    return { isRequest: true, song: rest, trigger };
  }

  return { isRequest: false, song: null, reason: '无触发词' };
}

/**
 * 从一句话里抠出"想听哪首"的弱信号（用于没打赏时的引导话术，不触发点歌）。
 * 故意和 parseSongRequest 分开：一个决定"做不做"，一个只决定"说什么"。
 */
export function looksLikeSongWish(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  return /想听|来一首|唱一首|点歌|点一首/.test(text) && QUESTION.test(text);
}
