/**
 * 串行播报队列。
 *
 * 修的是一个很要命的问题：**语音还没念完，下一句话就把它顶掉了**，
 * 而且气泡早就换成下一句了——观众看到的是"字说完了，声音才念到一半"。
 *
 * 现在的规矩：
 *   1. 一次只播一句，**说完才说下一句**（不抢占）；
 *   2. 气泡和音频**同时出现**（而不是合成完就先推文字）；
 *   3. 队列有上限，塞满时丢优先级最低的（宁可少说一句，不能越积越久）；
 *   4. 没人在看就不合成，也不排队。
 *
 * 代价是高峰期会有几秒延迟——但"晚说一句"比"说半句被掐"好得多。
 */
import { logger } from '../log.mjs';
import { forSpeech } from '../text.mjs';

const log = logger('speech');

const PRIORITY = { chat: 1, gift: 2, game: 3, system: 4 };

export function createSpeaker({ voice, audio, push, hasAudience, maxQueue = 3, clock = () => Date.now() }) {
  const queue = [];
  let running = false;
  let seq = 0;
  const stats = { spoken: 0, dropped: 0, interrupted: 0, failed: 0 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.() ?? setTimeout(r, ms));

  /** 只出声、不推气泡（气泡由调用方自己推，比如打赏演出）。 */
  async function playVoiceOnly(text) {
    const line = forSpeech(text, { maxLen: 60 });
    if (!line) return;
    if (hasAudience && !hasAudience()) return;
    const spoken = await voice?.speak(line).catch(() => null);
    if (!spoken) {
      stats.failed++;
      return;
    }
    const id = `v_${++seq}`;
    const voiceId = audio?.playVoice({ id, file: spoken.file, durationMs: spoken.durationMs });
    if (voiceId) await audio.waitVoice(voiceId, (spoken.durationMs ?? 3000) + 6000);
  }

  async function run(job) {
    const { text, opts } = job;
    const line = forSpeech(text, { maxLen: opts.maxLen ?? 60 });
    if (!line) return;

    const ok = !hasAudience || hasAudience();
    const spoken = ok ? await voice?.speak(line).catch(() => null) : null;

    // 气泡与音频同时出现：先算好时长，再一起发
    const dur = spoken?.durationMs ?? 0;
    const bubbleMs = Math.max(opts.ms ?? 2600, dur + 800);
    push({
      type: 'act',
      mood: opts.mood ?? 'happy',
      motion: opts.motion,
      line,
      ms: bubbleMs,
      heart: false,
      tier: 0,
    });

    if (!spoken) {
      // 没声音就按字数等一会儿，保证节奏不至于瞬间刷过去
      stats.failed++;
      await sleep(Math.min(2600, 700 + Array.from(line).length * 55));
      return;
    }

    const id = `v_${++seq}`;
    const voiceId = audio?.playVoice({ id, file: spoken.file, durationMs: spoken.durationMs });
    if (voiceId) {
      await audio.waitVoice(voiceId, (spoken.durationMs ?? 3000) + 6000);
      stats.spoken++;
    }
  }

  async function drain() {
    if (running) return;
    if (!queue.length) return;
    running = true;
    const job = queue.shift();
    try {
      await run(job);
    } catch (err) {
      log.error('播报失败：', err);
    } finally {
      running = false;
      job.resolve();
      drain();
    }
  }

  function enqueue(text, opts) {
    const priority = PRIORITY[opts.priority ?? 'chat'] ?? 1;
    return new Promise((resolve) => {
      if (queue.length >= maxQueue) {
        // 丢掉队列里优先级最低、且比当前这条低的
        const idx = queue.reduce((worst, cur, i) => (cur.priority < queue[worst].priority ? i : worst), 0);
        if (queue[idx].priority <= priority) {
          const dropped = queue.splice(idx, 1)[0];
          stats.dropped++;
          dropped.resolve();
        } else {
          stats.dropped++;
          resolve();
          return;
        }
      }
      queue.push({ text, opts, priority, resolve });
      queue.sort((a, b) => b.priority - a.priority);
      drain();
    });
  }

  return {
    /** 说一句：推气泡 + 出声，等这句真的说完才 resolve。 */
    speak: (text, opts = {}) => enqueue(text, opts),
    /** 只出声（气泡已经由别处推过），比如打赏演出。 */
    voiceOnly: (text) => playVoiceOnly(text).catch(() => {}),
    get busy() {
      return running || queue.length > 0;
    },
    stats: () => ({ ...stats, queued: queue.length, busy: running }),
    /** 立刻清空队列（停止游戏/重置时用）。 */
    clear() {
      while (queue.length) queue.shift().resolve();
    },
  };
}
