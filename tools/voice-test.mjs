import { load, resolved } from '../src/config.mjs';
import { createVoice } from '../src/voice/index.mjs';

const cfg = await load();
const voice = await createVoice({
  ...cfg.voice,
  clipsDir: resolved(cfg.voice.clipsDir),
  cacheDir: resolved(cfg.voice.cacheDir),
  pythonPath: resolved(cfg.voice.pythonPath),
});

console.log('clips:', voice.stats().clips);

const t0 = Date.now();
const clip = await voice.speak('在呢在呢');
console.log('clip  :', clip?.source, Math.round(Date.now() - t0) + 'ms', clip?.file?.slice(-40));

const t1 = Date.now();
const first = await voice.speak('你好呀，我是小鲸鱼');
console.log('tts#1 :', first?.source, Math.round(Date.now() - t1) + 'ms', first?.durationMs + 'ms', first?.file?.slice(-40));

const t2 = Date.now();
const second = await voice.speak('你好呀，我是小鲸鱼');
console.log('tts#2 :', second?.source, Math.round(Date.now() - t2) + 'ms');

console.log('stats :', JSON.stringify(voice.stats()));
console.log('mode  :', voice.stats().available);
process.exit(0);
