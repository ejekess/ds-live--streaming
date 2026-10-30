/**
 * 音频通道的纯状态机。
 *
 * 单独拆出来的理由：这里全是"谁压谁、谁能打断谁"的判断，最容易写错也最该能单测。
 * 它不碰网络、不碰定时器，输入 (state, action) → 输出 (state, emit)。
 * 真正的定时器和 WS 推送在 channel.mjs 里。
 *
 * 三条规则（对应文档 §5.2）：
 *   1. 同一时刻只有一首 music；
 *   2. voice 可以叠在 music 上，此时把 music 压到 duck 比例；
 *   3. voice 之间互相抢占——新的一顶掉旧的，因为直播里说两遍不如说一遍新的。
 */

export function initialState() {
  return { music: null, voice: null, ducked: false };
}

/**
 * @param {object} state
 * @param {object} action
 * @returns {{state:object, emit:Array<object>}}
 */
export function reduce(state, action) {
  switch (action.type) {
    case 'playVoice': {
      const emit = [];
      if (state.voice) emit.push({ cmd: 'stopVoice', id: state.voice.id });
      const next = { ...state, voice: action.item };
      if (state.music && !state.ducked) {
        next.ducked = true;
        emit.push({ cmd: 'duck', gain: action.duckGain ?? 0.3 });
      }
      emit.push({ cmd: 'playVoice', item: action.item });
      return { state: next, emit };
    }

    case 'voiceDone': {
      if (!state.voice || (action.id && state.voice.id !== action.id)) {
        return { state, emit: [] };
      }
      const next = { ...state, voice: null };
      const emit = [];
      if (state.music && state.ducked) {
        next.ducked = false;
        emit.push({ cmd: 'duck', gain: 1 });
      }
      return { state: next, emit };
    }

    case 'playMusic': {
      if (state.music) {
        // 正在唱，不打断；交给队列稍后再来
        return { state, emit: [{ cmd: 'busy' }] };
      }
      return {
        state: { ...state, music: action.item },
        emit: [{ cmd: 'playMusic', item: action.item }],
      };
    }

    case 'musicDone': {
      if (!state.music || (action.id && state.music.id !== action.id)) {
        return { state, emit: [] };
      }
      const finished = state.music;
      const next = { ...state, music: null, ducked: false };
      return { state: next, emit: [{ cmd: 'musicEnded', item: finished, reason: action.reason }] };
    }

    case 'stopMusic': {
      if (!state.music) return { state, emit: [] };
      const stopped = state.music;
      const next = { ...state, music: null, ducked: false };
      return { state: next, emit: [{ cmd: 'stopMusic', id: stopped.id }] };
    }

    case 'reset':
      return { state: initialState(), emit: [] };

    default:
      return { state, emit: [] };
  }
}

/** 推导全局音频模式，给管控台看。 */
export function modeOf(state) {
  if (state.music) return 'singing';
  if (state.voice) return 'speaking';
  return 'silent';
}
