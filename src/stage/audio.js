/**
 * 舞台音频：两个 <audio> 元素，一条给歌，一条给说话。
 *
 * 为什么分成两个元素而不是一个：唱歌的时候她还要说话（报幕、感谢），
 * 这时候需要把歌压低（duck）而不是掐断。一个元素做不到"同时播两路"。
 *
 * 与服务的约定：每条播放指令带 id，播完/出错都要回报 `audio-done`，
 * 服务端靠它对账并推进队列；15 秒不回报会被服务端强制推进。
 */

const RAMP_MS = 220;

export function createStageAudio({ send } = {}) {
  const els = {
    music: new Audio(),
    voice: new Audio(),
  };
  for (const el of Object.values(els)) {
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
  }

  /** 当前正在播的 id，用于过滤掉"上一次播放"的迟到事件。 */
  const cur = { music: null, voice: null };
  let ramp = null;

  function report(track, id, reason) {
    if (!id) return;
    try {
      send?.({ type: 'audio-done', id, track, reason });
    } catch {
      /* 忽略：断线时丢了就靠服务端超时兜底 */
    }
  }

  function bind(track) {
    const el = els[track];
    el.addEventListener('ended', () => {
      const id = cur[track];
      cur[track] = null;
      report(track, id, 'ended');
    });
    el.addEventListener('error', () => {
      const id = cur[track];
      cur[track] = null;
      report(track, id, 'error');
    });
  }
  bind('music');
  bind('voice');

  function rampTo(value) {
    const el = els.music;
    if (ramp) clearInterval(ramp);
    const from = el.volume;
    const to = Math.max(0, Math.min(1, value));
    const steps = 8;
    let i = 0;
    ramp = setInterval(() => {
      i += 1;
      el.volume = Math.max(0, Math.min(1, from + ((to - from) * i) / steps));
      if (i >= steps) {
        clearInterval(ramp);
        ramp = null;
      }
    }, RAMP_MS / steps);
  }

  function play(track, { src, id, gain = 1 }) {
    const el = els[track];
    if (!src) {
      report(track, id, 'error');
      return;
    }
    cur[track] = id;
    el.src = src;
    el.volume = Math.max(0, Math.min(1, gain));
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        // 浏览器自动播放限制 / 解码失败：回报，让服务端推进而不是卡住
        cur[track] = null;
        report(track, id, 'error');
        console.warn('[stage] 播放失败', track, err?.name, err?.message);
      });
    }
  }

  function stop(track, id) {
    if (id && cur[track] && cur[track] !== id) return;
    const el = els[track];
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {}
    cur[track] = null;
  }

  return {
    handle(msg) {
      const track = msg.track === 'music' ? 'music' : 'voice';
      if (msg.action === 'stop') {
        stop(track, msg.id);
        return;
      }
      if (msg.action === 'duck') {
        if (track === 'music') rampTo(msg.gain ?? 1);
        return;
      }
      play(track, msg);
    },
    stopAll() {
      stop('music');
      stop('voice');
    },
    state() {
      return {
        music: cur.music ? { id: cur.music, paused: els.music.paused, t: els.music.currentTime } : null,
        voice: cur.voice ? { id: cur.voice, paused: els.voice.paused } : null,
        musicVolume: els.music.volume,
      };
    },
  };
}
