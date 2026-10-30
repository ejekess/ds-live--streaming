/**
 * 音频通道：把纯状态机（state.mjs）接到真实世界——WS 推送、定时器、对账。
 *
 * 这里唯一复杂的东西是**对账**：浏览器才是真正在播的那一方，
 * 服务端只知道"我让它播了"。所以每条指令都有 id，舞台播完回报 `audio-done`；
 * 同时服务端自己按 durationMs 定时兜底——舞台崩了、页面卡了，也不能让队列永远卡住。
 */
import { logger } from '../log.mjs';
import { initialState, reduce, modeOf } from './state.mjs';

const log = logger('audio');

export function createAudioChannel({ push, mediaUrl, duckRatio = 0.3, graceMs = 6000, clock = () => Date.now() }) {
  let state = initialState();
  const timers = new Map();
  const listeners = { musicEnded: [] };
  /** 等待某条语音播完的 resolve 列表（报幕要等它说完再起歌）。 */
  const voiceWaiters = new Map();
  const stats = { played: 0, ducked: 0, timeouts: 0 };

  function clearTimer(id) {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function arm(id, durationMs, kind) {
    clearTimer(id);
    const wait = Math.max(1500, (Number(durationMs) || 3000) + graceMs);
    const t = setTimeout(() => {
      timers.delete(id);
      stats.timeouts++;
      log.warn(`音频 ${id} 未收到舞台回报，超时推进（${kind}）`);
      dispatch(kind === 'music' ? { type: 'musicDone', id, reason: 'timeout' } : { type: 'voiceDone', id });
    }, wait);
    t.unref?.();
    timers.set(id, t);
  }

  function srcOf(item) {
    const url = mediaUrl?.(item.file);
    if (!url) {
      log.warn(`音频文件不在媒体挂载点下，无法播放：${item.file}`);
      return null;
    }
    return url;
  }

  function handleEmit(e) {
    switch (e.cmd) {
      case 'playVoice': {
        const src = srcOf(e.item);
        if (!src) return;
        push({ type: 'audio', track: 'voice', src, id: e.item.id, gain: 1 });
        arm(e.item.id, e.item.durationMs, 'voice');
        stats.played++;
        break;
      }
      case 'stopVoice':
        push({ type: 'audio', track: 'voice', action: 'stop', id: e.id });
        clearTimer(e.id);
        break;
      case 'playMusic': {
        const src = srcOf(e.item);
        if (!src) {
          // 无 URL 也要推进，否则队列卡死
          dispatch({ type: 'musicDone', id: e.item.id, reason: 'no-src' });
          return;
        }
        push({ type: 'audio', track: 'music', src, id: e.item.id, gain: 1 });
        arm(e.item.id, e.item.durationMs, 'music');
        stats.played++;
        break;
      }
      case 'duck':
        push({ type: 'audio', track: 'music', action: 'duck', gain: e.gain });
        stats.ducked++;
        break;
      case 'stopMusic':
        push({ type: 'audio', track: 'music', action: 'stop', id: e.id });
        clearTimer(e.id);
        // 手动停止也要走上报，否则队列里这条永远停在 playing
        for (const fn of listeners.musicEnded) {
          try {
            fn(e.item ?? { id: e.id }, 'stopped');
          } catch (err) {
            log.error('musicEnded 监听器出错：', err);
          }
        }
        break;
      case 'musicEnded':
        clearTimer(e.item.id);
        for (const fn of listeners.musicEnded) {
          try {
            fn(e.item, e.reason);
          } catch (err) {
            log.error('musicEnded 监听器出错：', err);
          }
        }
        break;
      case 'busy':
        break;
      default:
        break;
    }
  }

  function dispatch(action) {
    const beforeVoice = state.voice?.id ?? null;
    const out = reduce(state, { ...action, duckGain: duckRatio });
    state = out.state;
    // 语音真的结束了（被顶掉或播完）才唤醒等待者
    if (beforeVoice && !state.voice) {
      for (const resolve of voiceWaiters.get(beforeVoice) ?? []) resolve();
      voiceWaiters.delete(beforeVoice);
    }
    for (const e of out.emit) handleEmit(e);
    return out.emit;
  }

  return {
    /** 播一句话。返回是否接受（music 正在播时 voice 也能播，返回 true）。 */
    playVoice(item) {
      const ok = dispatch({ type: 'playVoice', item }).some((e) => e.cmd === 'playVoice');
      return ok ? item.id : null;
    },

    /** 等到某条语音播完（或超时）。报幕用。 */
    waitVoice(id, timeoutMs = 8000) {
      if (!id) return Promise.resolve();
      if (state.voice?.id !== id) return Promise.resolve();
      return new Promise((resolve) => {
        const list = voiceWaiters.get(id) ?? [];
        list.push(resolve);
        voiceWaiters.set(id, list);
        const t = setTimeout(() => {
          const cur = voiceWaiters.get(id) ?? [];
          const i = cur.indexOf(resolve);
          if (i >= 0) cur.splice(i, 1);
          resolve();
        }, timeoutMs);
        t.unref?.();
      });
    },

    /** 播一首歌。music 已占用时返回 false（调用方稍后再试）。 */
    playMusic(item) {
      return dispatch({ type: 'playMusic', item }).some((e) => e.cmd === 'playMusic');
    },

    stopMusic() {
      const cur = state.music;
      dispatch({ type: 'stopMusic' });
      return cur?.id ?? null;
    },

    /** 舞台回报。 */
    audioDone(id, reason = 'ended') {
      if (state.voice?.id === id) return dispatch({ type: 'voiceDone', id });
      if (state.music?.id === id) return dispatch({ type: 'musicDone', id, reason });
      return [];
    },

    /** 舞台重连后同步一次，避免它那边一片空白。 */
    resync() {
      if (state.music) {
        const src = srcOf(state.music);
        if (src) push({ type: 'audio', track: 'music', src, id: state.music.id, gain: 1, resume: true });
      }
      return { mode: modeOf(state), music: state.music?.id ?? null, voice: state.voice?.id ?? null };
    },

    onMusicEnded(fn) {
      listeners.musicEnded.push(fn);
      return () => {
        const i = listeners.musicEnded.indexOf(fn);
        if (i >= 0) listeners.musicEnded.splice(i, 1);
      };
    },

    /** 没有任何音频时才能开下一首。 */
    get busy() {
      return Boolean(state.music);
    },

    state() {
      return {
        mode: modeOf(state),
        ducked: state.ducked,
        music: state.music ? { id: state.music.id, durationMs: state.music.durationMs } : null,
        voice: state.voice ? { id: state.voice.id, durationMs: state.voice.durationMs } : null,
        stats: { ...stats },
        now: clock(),
      };
    },
  };
}
