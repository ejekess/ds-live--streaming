/**
 * 语音合成门面：文本 → 音频文件。
 *
 * 三级策略，越靠前越便宜：
 *   1. 固定短语命中 → 直接给现成文件（0ms）
 *   2. 缓存命中     → 直接给文件（0ms）
 *   3. 调 edge-tts  → 300–600ms，结果进缓存
 *
 * 失败返回 null，**绝不抛异常**：直播里说不了话可以退化成气泡，
 * 但让整条回复链路炸掉是不可接受的。
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { logger } from '../log.mjs';
import { forSpeech } from '../text.mjs';
import { createClips } from './clips.mjs';
import { createEdgeTts } from './edge.mjs';

const run = promisify(execFile);
const log = logger('voice');

/** ffprobe 读时长；没有就按 edge-tts 的 48kbps（6000 B/s）估算。 */
async function probeMs(file, bytes) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 5000 });
    const sec = Number(String(stdout).trim());
    if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  } catch {}
  return Math.max(300, Math.round((bytes / 6000) * 1000));
}

export async function createVoice(cfg = {}) {
  const clips = createClips(cfg.clipsDir);
  const cacheDir = cfg.cacheDir ?? path.join('data', 'voice', 'cache');
  await mkdir(cacheDir, { recursive: true }).catch(() => {});

  const tts = createEdgeTts({
    python: cfg.python ?? 'python',
    pythonPath: cfg.pythonPath,
    voice: cfg.voice ?? 'zh-CN-XiaoyiNeural',
    pitch: cfg.pitch ?? '+12Hz',
    rate: cfg.rate ?? '-20%',
  });

  /** 内存缓存，避免每条都去 stat 一次磁盘。 */
  const memo = new Map();
  const stats = { synth: 0, cacheHits: 0, clipHits: 0, failures: 0 };

  function keyOf(text) {
    return createHash('sha1').update(`${cfg.voice}|${cfg.pitch}|${cfg.rate}|${text}`).digest('hex').slice(0, 16);
  }

  /**
   * @param {string} rawText
   * @param {{useClips?:boolean}} [opts]
   * @returns {Promise<{file:string, durationMs:number, source:'clip'|'cache'|'tts'}|null>}
   */
  async function speak(rawText, opts = {}) {
    const text = forSpeech(rawText, { maxLen: cfg.maxLen ?? 48 });
    if (!text) return null;

    // 1. 固定短语
    if (opts.useClips !== false && cfg.preferClips !== false) {
      const clip = clips.find(text);
      if (clip) {
        try {
          const info = await stat(clip.file);
          stats.clipHits++;
          return { file: clip.file, durationMs: await probeMs(clip.file, info.size), source: 'clip' };
        } catch {
          /* 文件不见了就走合成 */
        }
      }
    }

    // 2. 缓存
    const key = keyOf(text);
    const hit = memo.get(key);
    if (hit && existsSync(hit.file)) {
      stats.cacheHits++;
      return { ...hit, source: 'cache' };
    }
    const cacheFile = path.join(cacheDir, `${key}.mp3`);
    if (existsSync(cacheFile)) {
      try {
        const info = await stat(cacheFile);
        const item = { file: cacheFile, durationMs: await probeMs(cacheFile, info.size) };
        memo.set(key, item);
        stats.cacheHits++;
        return { ...item, source: 'cache' };
      } catch {}
    }

    // 3. 合成
    if (cfg.enabled === false) return null;
    const started = Date.now();
    const res = await tts.synth(text, cacheFile);
    if (!res.ok) {
      stats.failures++;
      log.warn(`合成失败「${text}」：${res.error}`);
      return null;
    }
    try {
      const info = await stat(cacheFile);
      const item = { file: cacheFile, durationMs: await probeMs(cacheFile, info.size) };
      memo.set(key, item);
      stats.synth++;
      log.debug(`合成「${text}」${Date.now() - started}ms`);
      return { ...item, source: 'tts' };
    } catch (err) {
      stats.failures++;
      log.warn('合成产物读不到：', err?.message);
      return null;
    }
  }

  return {
    speak,
    clip: (key) => {
      const c = clips.get(key);
      return c ? { file: c.file, text: c.text } : null;
    },
    stats: () => ({ ...stats, clips: clips.size, available: tts.available }),
    stop: () => tts.stop(),
    warmup: () => tts.synth('嗯', path.join(cacheDir, '_warmup.mp3')),
  };
}
