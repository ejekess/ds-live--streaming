/**
 * 入口：把各个零件装起来并跑起来。
 *
 *          ┌──────────── 弹幕源（mock / replay / exec / cdp）
 *          ↓
 *      Bus ──→ Director ──→ 大脑（规则 / LLM 网关）
 *          │        │
 *          │        └──→ Hub ──→ 舞台页（OBS 浏览器源）
 *          └──→ 管控台（HTTP + WS）
 *
 * 启动顺序有讲究：先把舞台和控制台的服务拉起来，再连弹幕源——
 * 反过来的话，一开播观众就进来了，而鲸鱼娘还没加载完。
 */
// 必须第一个：后面的模块可能在初始化时就读 process.env
import './env.mjs';
import http from 'node:http';
import path from 'node:path';
import { load, get as getConfig, resolved, ROOT } from './config.mjs';
import { log, logger, recentLogs } from './log.mjs';
import { Bus } from './bus.mjs';
import { createBrain } from './brain/index.mjs';
import { Director } from './director.mjs';
import { GiftCatalog } from './reaction/catalog.mjs';
import { Hub } from './server/ws.mjs';
import { createApi } from './server/api.mjs';
import { serveStatic, sendText, sendJson } from './server/http.mjs';
import { createMockSource } from './sources/mock.mjs';
import { createReplaySource } from './sources/replay.mjs';
import { createExecSource } from './sources/exec.mjs';
import { createVoice } from './voice/index.mjs';
import { createAudioChannel } from './audio/channel.mjs';
import { createSongService } from './songs/index.mjs';
import { createMedia } from './server/media.mjs';
import { createStats } from './stats.mjs';

const boot = logger('boot');

const MOUNTS = [
  { prefix: '/stage', root: path.join(ROOT, 'src', 'stage'), index: 'stage.html' },
  { prefix: '/admin', root: path.join(ROOT, 'src', 'admin'), index: 'index.html' },
  { prefix: '/dsh-pet', root: path.join(ROOT, 'vendor', 'whale-girl', 'assets') },
];

async function createSource(cfg, ctx) {
  switch (cfg.source.kind) {
    case 'mock':
      return createMockSource(cfg, ctx);
    case 'replay':
      return createReplaySource(cfg, ctx);
    case 'exec':
      return createExecSource(cfg, ctx);
    case 'cdp': {
      const { createCdpSource } = await import('./sources/cdp.mjs');
      return createCdpSource(cfg, ctx);
    }
    default:
      throw new Error(`未知弹幕源：${cfg.source.kind}`);
  }
}

async function main() {
  const cfg = await load();

  // —— 舞台素材：确保 pet.patched.js 已就位（幂等，缺了才生成）——
  const { ensurePatched } = await import('../tools/patch-pet.mjs');
  const patch = await ensurePatched();
  if (!patch.ok) boot.warn(`舞台补丁未生效：${patch.reason}（舞台会走兜底字幕）`);

  // —— 礼物目录 ——
  const catalog = new GiftCatalog();
  await catalog.ensureFile(cfg.gifts.catalog);
  await catalog.load(cfg.gifts.catalog, cfg.gifts.overrides);

  // —— 大脑 ——
  const brain = await createBrain(cfg);

  const bus = new Bus();

  // —— HTTP ——
  const runtime = { director: null, hub: null, source: null };
  const api = createApi({ runtime, brain, catalog, bus });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await api.handle(req, res, url);
        if (!handled) sendJson(res, 404, { ok: false, error: 'no such api' });
        return;
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === '/' || url.pathname === '/admin') {
        res.writeHead(302, { location: '/admin/' });
        res.end();
        return;
      }
      if (url.pathname === '/avatar') {
        const ok = await serveStatic(req, res, [{ prefix: '/avatar', root: path.join(ROOT, 'src', 'stage'), index: 'stage.html' }], '/avatar/');
        if (!ok) sendText(res, 404, 'stage not built');
        return;
      }

      // pet.js 会连宿主的事件流（SSE）。我们没有宿主，就挂一条只发心跳的流，
      // 让它安静地待着，而不是每 3 秒报一次连接错误。
      if (url.pathname === '/dsh-pet/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => clearInterval(ping));
        return;
      }
      // 其余 /dsh-pet/* 的无扩展名路径（say / cancel / hud 等）直接 204，
      // 避免 404 噪音干扰真正的报错
      if (url.pathname.startsWith('/dsh-pet/') && !path.extname(url.pathname)) {
        res.writeHead(204);
        res.end();
        return;
      }

      // 浏览器发来的路径是百分号编码的（中文文件名尤其明显），
      // 不解码就会拿 `%E5%91%A8...` 当字面文件名去找，必然 404。
      let pathname = url.pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        /* 畸形编码就按原样处理，交给静态层拒绝 */
      }
      const ok = await serveStatic(req, res, MOUNTS, pathname);
      if (!ok) sendText(res, 404, 'not found');
    } catch (err) {
      log.error('请求处理失败：', err);
      if (!res.headersSent) sendText(res, 500, 'internal error');
    }
  });

  // —— WS ——
  const hub = new Hub(server);
  runtime.hub = hub;

  // —— 舞台代理 ——
  const stage = {
    push: (msg) => hub.push(msg),
    // 有没有正在看的舞台：没人看就不放歌，免得白播一场
    hasClients: () => hub.counts.stages > 0,
  };

  // —— 媒体路由：音频文件 → 浏览器可访问 URL ——
  // 只允许白名单目录，URL 里不出现绝对路径，从根上避免路径穿越。
  const media = createMedia([
    { prefix: '/media/voice', root: resolved('data/voice') },
    { prefix: '/media/clip', root: resolved(cfg.voice.clipsDir) },
    { prefix: '/media/render', root: resolved(cfg.songs.renderedDir) },
    { prefix: '/media/lib', root: resolved(cfg.songs.libraryDir) },
  ]);
  MOUNTS.push(...media.mounts.map((m) => ({ prefix: m.prefix, root: m.root })));

  // —— 音频通道（双轨：歌 + 话） ——
  const audio = createAudioChannel({
    push: (msg) => hub.push(msg),
    mediaUrl: (file) => media.url(file),
    duckRatio: cfg.voice.duckRatio ?? 0.3,
  });

  // 舞台播完/播挂都要回执，否则只能等超时
  hub.setAudioDoneHandler((m) => audio.audioDone(m.id, m.reason || "ended"));

  // —— 语音合成 ——
  const voice = await createVoice({
    ...cfg.voice,
    clipsDir: resolved(cfg.voice.clipsDir),
    cacheDir: resolved(cfg.voice.cacheDir),
    pythonPath: resolved(cfg.voice.pythonPath),
  });
  boot.info(`语音：${voice.stats().clips} 条固定短语，${cfg.voice.enabled ? 'TTS 已启用' : 'TTS 已关闭'}`);

  // —— 点歌服务 ——
  const songs = await createSongService({
    ...cfg.songs,
    libraryDir: resolved(cfg.songs.libraryDir),
    stateDir: resolved(cfg.songs.stateDir),
    queueFile: resolved(cfg.songs.queueFile),
    quotaFile: resolved(cfg.songs.quotaFile),
    renderedDir: resolved(cfg.songs.renderedDir),
  });
  boot.info(`点歌：曲库 ${songs.snapshot().library} 首，渲染器 ${songs.snapshot().renderer}`);

  // —— 导演 ——
  const stats = createStats({ file: 'data/stats.json' });
  await stats.load();
  const director = new Director({ cfg, brain, stage, catalog, voice, audio, songs, stats });
  runtime.director = director;
  hub.stageResync = () => director.gameStageSnapshot();
  runtime.stats = stats;

  // —— 弹幕源 ——
  const emit = (events) => {
    bus.emit('live', events);
    // 管控台的「现场」标签页直接吃这一路，免得为每条弹幕去轮询接口
    hub.broadcastAdmin({ type: 'live', data: events });
    try {
      director.handle(events);
    } catch (err) {
      log.error('处理直播事件失败：', err);
    }
  };

  let source = null;
  const onStatus = (status) => hub.broadcastAdmin({ type: 'source', data: status });

  // —— 状态心跳：每 2 秒把导演快照推给管控台 ——
  const heartbeat = setInterval(() => {
    try {
      hub.updateState(director.state);
    } catch (err) {
      log.debug('心跳失败：', err?.message);
    }
  }, 2000);

  await director.start();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.server.port, cfg.server.host, resolve);
  });

  const base = `http://${cfg.server.host}:${cfg.server.port}`;
  boot.info('——————————————————————————————');
  boot.info(`  舞台（OBS 浏览器源）： ${base}/avatar`);
  boot.info(`  管控台：               ${base}/admin/`);
  boot.info(`  弹幕源：${cfg.source.kind}   大脑：${cfg.brain.kind}`);
  boot.info('——————————————————————————————');

  try {
    source = await createSource(cfg, { emit, onStatus });
    runtime.source = source;
    await source.start();
  } catch (err) {
    boot.error('弹幕源启动失败，舞台仍可用（可用管控台手动触发）：', err);
  }

  // —— 退出 ——
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    boot.info(`收到 ${signal}，正在收摊…`);
    clearInterval(heartbeat);
    try {
      await source?.stop();
    } catch {}
    try {
      await director.stop();
    } catch {}
    try { voice?.stop(); } catch {}
    try { audio?.stopMusic(); } catch {}
    hub.close();
    server.close(() => process.exit(0));
    // 兜底：5 秒还没退干净就硬退
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 别让一个未捕获的 Promise 弄死整场直播
  process.on('unhandledRejection', (reason) => log.error('未处理的 Promise 拒绝：', reason));
  process.on('uncaughtException', (err) => log.error('未捕获异常（进程继续）：', err));
}

main().catch((err) => {
  log.error('启动失败：', err);
  process.exit(1);
});
