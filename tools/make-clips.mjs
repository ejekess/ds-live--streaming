/**
 * 批量生成固定短语（缺谁补谁）。
 *
 *   node tools/make-clips.mjs                 # 输出到 data/voice/clips
 *   node tools/make-clips.mjs --dir=D:/x      # 指定输出目录
 *   node tools/make-clips.mjs --force         # 全部重生成
 *
 * 生成完之后把 `config/config.json` 的 `voice.clipsDir` 指到这个目录，
 * 就能命中「零延迟、零成本」的预生成语音。
 *
 * 音色参数与已有的 24 条语音库保持一致（晓伊 / +12Hz / -20%），
 * 这样预生成的和实时合成的听起来是同一个人。
 */
import { mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { load, resolved } from '../src/config.mjs';
import { createEdgeTts } from '../src/voice/edge.mjs';
import { CLIP_TABLE } from '../src/voice/clips.mjs';

const argDir = process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1];
const force = process.argv.includes('--force');

const cfg = await load();
const outDir = argDir ? path.resolve(argDir) : resolved('data/voice/clips');
await mkdir(outDir, { recursive: true });

const tts = createEdgeTts({
  python: cfg.voice.python,
  pythonPath: resolved(cfg.voice.pythonPath),
  voice: cfg.voice.voice,
  pitch: cfg.voice.pitch,
  rate: cfg.voice.rate,
});

let made = 0;
let skipped = 0;
let failed = 0;

for (const [key, text] of CLIP_TABLE) {
  const file = path.join(outDir, `${key}.mp3`);
  if (!force && existsSync(file)) {
    skipped++;
    continue;
  }
  const res = await tts.synth(text, file);
  if (res.ok) {
    const size = (await stat(file)).size;
    console.log(`  ✓ ${key}.mp3  ${text}  ${(size / 1024).toFixed(0)}KB`);
    made++;
  } else {
    console.error(`  ✗ ${key}  ${res.error}`);
    failed++;
  }
}

tts.stop();
console.log(`\n完成：新增 ${made}，跳过 ${skipped}，失败 ${failed}`);
console.log(`输出目录：${outDir}`);
console.log(`提示：把 config.json 的 voice.clipsDir 指到这里即可生效`);
process.exit(failed > 0 ? 1 : 0);
