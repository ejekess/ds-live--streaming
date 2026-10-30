/**
 * WebSocket 广播：舞台（OBS 里的那个页面）和管控台都挂在同一个 hub 上。
 *
 * 两种客户端消费方式不同：
 *   · 舞台要的是「指令流」——act / effect / feed，越快越好，丢一条不致命；
 *   · 管控台要的是「状态快照」——在线人数、最近事件、队列长度。
 * 所以 hub 分成两组广播，并给新连上的客户端补一份最近状态，
 * 这样刷新页面不会看到一片空白。
 */
import { WebSocketServer } from 'ws';
import { logger } from '../log.mjs';

const log = logger('ws');

export class Hub {
  #wss;
  #stages = new Set();
  #admins = new Set();
  #lastState = null;
  #recent = [];
  /** 舞台回报音频播放结果时调用（由 index.mjs 接到 audio 通道上）。 */
  #onAudioDone = null;
  /** 舞台接入时补一条当前对局（由 index.mjs 接到导演上）。 */
  stageResync = null;

  constructor(server, { pathname = '/ws' } = {}) {
    this.#wss = new WebSocketServer({ noServer: true });
    this.#wss.on('connection', (socket, req, role) => this.#onConnection(socket, role));

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== pathname) {
        socket.destroy();
        return;
      }
      const role = url.searchParams.get('role') === 'admin' ? 'admin' : 'stage';
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#wss.emit('connection', ws, req, role);
      });
    });
  }

  /**
   * 新连接要补的历史。舞台额外补一条当前对局——
   * 页面在半局中途刷新（OBS 重载）时，光靠历史消息可能补不出词板。
   */
  #recentFor(role) {
    const recent = this.#recent.slice(-40);
    if (role !== 'stage') return recent;
    try {
      const resync = this.stageResync?.();
      if (resync) recent.push(resync);
    } catch {
      /* 补不到就算了，不影响连接 */
    }
    return recent;
  }

  #onConnection(socket, role) {
    const set = role === 'admin' ? this.#admins : this.#stages;
    set.add(socket);
    log.info(`${role} 接入（当前 舞台 ${this.#stages.size} / 管控台 ${this.#admins.size}）`);

    socket.send(JSON.stringify({ type: 'hello', role, recent: this.#recentFor(role), state: this.#lastState }));
    if (role === 'stage') {
      // 舞台重连时立刻同步一次基础状态，避免黑屏等人来操作
      socket.send(JSON.stringify({ type: 'base', mood: 'neutral', props: [] }));
    }

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.type === 'ready') {
        socket.send(JSON.stringify({ type: 'hello', role, recent: this.#recentFor(role), state: this.#lastState }));
      }
      // 舞台上报自身状态（模型尺寸、错误），转给管控台看
      if (msg?.type === 'stage-status') {
        // 记住最近一次自报，方便从 /api/state 判断舞台是不是旧版
        this.lastStage = { ...(msg.data ?? {}), at: Date.now() };
        this.broadcastAdmin({ type: 'stage-status', data: msg.data });
      }
      // 音频播完/失败：必须转给 audio 通道，否则每条语音都只能等 15 秒超时
      if (msg?.type === 'audio-done') {
        try {
          this.#onAudioDone?.(msg);
        } catch (err) {
          log.warn('处理 audio-done 出错：', err?.message);
        }
        this.broadcastAdmin({ type: 'audio-done', data: msg });
      }
    });

    socket.on('close', () => {
      set.delete(socket);
      log.debug(`${role} 断开`);
    });
    socket.on('error', (err) => log.warn(`${role} 连接出错：`, err?.message));
  }

  /** 注册音频回报处理器（index.mjs 启动时接上）。 */
  setAudioDoneHandler(fn) {
    this.#onAudioDone = fn;
  }

  /** 给舞台的指令。同时记进 recent，供新连接的舞台补课。 */
  push(msg) {
    this.#recent.push(msg);
    if (this.#recent.length > 80) this.#recent.splice(0, this.#recent.length - 80);
    const text = JSON.stringify(msg);
    for (const socket of this.#stages) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
    // 管控台也看一份，方便对着时间线排查
    this.broadcastAdmin({ type: 'stage-cmd', data: msg });
  }

  broadcastAdmin(msg) {
    const text = JSON.stringify(msg);
    for (const socket of this.#admins) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }

  updateState(state) {
    this.#lastState = state;
    this.broadcastAdmin({ type: 'state', data: state });
  }

  get counts() {
    return { stages: this.#stages.size, admins: this.#admins.size };
  }

  close() {
    this.#wss.close();
    this.#stages.clear();
    this.#admins.clear();
  }
}
