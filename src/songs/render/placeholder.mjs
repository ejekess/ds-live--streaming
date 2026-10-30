/**
 * 占位渲染器：不依赖 RVC 环境，也能把整条链路跑通。
 *
 * 它生成一段几秒的合成音（简单的琶音），假装"这首歌做好了"。
 * 作用是让队列、报幕、播放、对账这些逻辑在没有 GPU、没有模型的时候也能验收，
 * 真接 RVC 时只换 renderer 配置，上层一行不用改。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger } from '../../log.mjs';

const log = logger('songs:render');

const RATE = 22050;

/** 生成一个 44.1kHz 16bit 单声道 WAV（几秒的琶音，听起来像"在放歌"）。 */
function makeWav(seconds) {
  const total = Math.floor(RATE * seconds);
  const data = Buffer.alloc(total * 2);
  const notes = [262, 330, 392, 523, 392, 330]; // C E G C' G E
  const noteLen = Math.floor(total / notes.length);

  for (let i = 0; i < total; i++) {
    const idx = Math.floor(i / noteLen) % notes.length;
    const f = notes[idx];
    const t = i / RATE;
    // 带包络的正弦，避免爆音
    const env = Math.min(1, (i % noteLen) / (RATE * 0.02)) * (1 - (i % noteLen) / noteLen) ** 0.6;
    const v = Math.sin(2 * Math.PI * f * t) * 0.28 * env;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

export function createPlaceholderRenderer({ renderedDir, delayMs = 0, seconds = 6, clock = () => Date.now() }) {
  return {
    kind: 'placeholder',
    async render({ song }) {
      const started = clock();
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      await mkdir(renderedDir, { recursive: true });

      const hash = createHash('sha1').update(`placeholder:${song}:${seconds}`).digest('hex').slice(0, 10);
      const file = path.join(renderedDir, `ph_${hash}.wav`);
      await writeFile(file, makeWav(seconds));

      log.info(`[占位] 「${song}」渲染完成（${Math.round((clock() - started) / 1000)}s）`);
      return { file, durationMs: Math.round(seconds * 1000) };
    },
  };
}
