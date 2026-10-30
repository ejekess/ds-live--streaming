/**
 * 固定短语库。
 *
 * 这些是**预生成**好的 mp3（来自你现有的 24 条语音库），播它们零延迟、零成本。
 * 表里的第二个字段是"她实际说的那句话"——文件名是 `01_在呢.mp3`，
 * 但音频内容其实是"在呢在呢"，所以必须按文本建索引，否则永远命中不了。
 */
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/** 文件名 → 实际说的话（与 gen_voice_lib.py 的 CLIPS 表保持一致）。 */
export const CLIP_TABLE = [
  ['01_在呢', '在呢在呢'],
  ['02_来啦', '来啦来啦'],
  ['03_好呀', '好呀'],
  ['04_行吧', '行吧行吧'],
  ['05_嗯嗯', '嗯嗯'],
  ['06_贴贴', '要贴贴'],
  ['07_不嘛', '人家不嘛'],
  ['08_哼', '哼，生气了'],
  ['09_好耶', '好耶'],
  ['10_呜呜', '呜呜呜'],
  ['11_气鼓鼓', '气鼓鼓'],
  ['12_困了', '困了困了'],
  ['13_饿了', '饿了，想吃好吃的'],
  ['14_晚安', '睡啦，晚安'],
  ['15_嘿嘿', '嘿嘿嘿'],
  ['16_笑死', '笑死我了'],
  ['17_啊', '啊？'],
  ['18_再说一遍', '你再说一遍'],
  ['19_好厉害', '好厉害呀'],
  ['20_你真好', '你真好'],
  ['21_离谱', '离谱'],
  ['22_就你话多', '就你话多'],
  ['23_在干嘛', '在干嘛呀'],
  ['24_陪你', '陪你聊会儿'],
];

const norm = (s) => String(s ?? '').replace(/[\s\u3000，。！？、,.!?~～…]/g, '');

export function createClips(dir) {
  /** @type {Map<string,{key:string,text:string,file:string}>} */
  const byText = new Map();
  const byKey = new Map();

  if (dir && existsSync(dir)) {
    const files = new Set(readdirSync(dir).filter((f) => /\.(mp3|wav)$/i.test(f)));
    for (const [key, text] of CLIP_TABLE) {
      const file = [...files].find((f) => path.basename(f, path.extname(f)) === key);
      if (!file) continue;
      const entry = { key, text, file: path.join(dir, file) };
      byText.set(norm(text), entry);
      byKey.set(key, entry);
    }
  }

  return {
    size: byText.size,
    /** 按"她该说的那句话"精确命中。 */
    find(text) {
      return byText.get(norm(text)) ?? null;
    },
    get(key) {
      return byKey.get(key) ?? null;
    },
    list() {
      return [...byKey.values()].map((c) => ({ key: c.key, text: c.text }));
    },
  };
}
