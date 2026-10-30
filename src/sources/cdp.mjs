/**
 * 弹幕源：CDP 抓抖音直播间（真实直播间用这个）。
 *
 * 思路不是自己算签名去连 webcast WebSocket——那条路要复刻 a_bogus/mssdk，
 * 官方一改就全废。这里反过来：用本机浏览器打开直播间页面，**让它自己**完成
 * 握手和鉴权，我们只旁听它收到的 WebSocket 帧，再把 protobuf 解出来。
 *
 * 好处：不需要逆向签名、不需要自己维护 room_id 的获取逻辑、登录状态直接复用。
 * 代价：需要一个浏览器窗口（默认非 headless，抖音对无头环境不友好），
 *       以及页面自己会持续发心跳——我们纯被动，不干扰它。
 */
import { logger } from '../log.mjs';
import { decodeFrame } from '../douyin/decode.mjs';
import { resolved } from '../config.mjs';

const log = logger('cdp');

/** 只旁听推送信道，别把埋点/上传那些 WS 也解一遍。 */
const PUSH_URL = /webcast\/im\/push|\/webcast\/im\//i;

export function createCdpSource(cfg, { emit, onStatus }) {
  const opts = cfg.source.cdp;
  let context = null;
  let page = null;
  let stopped = true;
  let health = null;
  let watchdog = null;
  const stats = { frames: 0, decoded: 0, events: 0, sockets: 0, unknown: new Set(), lastFrameAt: 0, reloads: 0 };

  const status = () => ({
    kind: 'cdp',
    running: !stopped,
    roomUrl: opts.roomUrl,
    frames: stats.frames,
    events: stats.events,
    sockets: stats.sockets,
    lastFrameAgoMs: stats.lastFrameAt ? Date.now() - stats.lastFrameAt : null,
    unknownMethods: Array.from(stats.unknown).slice(0, 20),
  });

  function attach(ws) {
    const url = ws.url();
    if (!PUSH_URL.test(url)) return;
    stats.sockets++;
    log.info('已挂上推送信道：', url.slice(0, 90));
    ws.on('framereceived', (frame) => {
      const payload = frame?.payload;
      if (!payload || typeof payload === 'string') return;
      stats.frames++;
      stats.lastFrameAt = Date.now();
      try {
        const { events, meta } = decodeFrame(payload);
        for (const m of meta.unknown) stats.unknown.add(m);
        if (events.length) {
          stats.events += events.length;
          stats.decoded++;
          emit(events);
          onStatus?.(status());
        }
      } catch (err) {
        log.debug('解码这一帧失败：', err?.message);
      }
    });
    ws.on('socketerror', (err) => log.warn('推送信道出错：', err));
  }

  async function openPage() {
    const { chromium } = await import('playwright-core');
    if (!context) {
      const opts2 = {
        headless: Boolean(opts.headless),
        channel: opts.browserChannel || undefined,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        viewport: { width: 1280, height: 800 },
        args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
      };
      const userDataDir = opts.userDataDir ? resolved(opts.userDataDir) : undefined;
      context = userDataDir
        ? await chromium.launchPersistentContext(userDataDir, opts2)
        : await (await chromium.launch(opts2)).newContext(opts2);
      context.on('page', (p) => log.info('新页面：', p.url().slice(0, 80)));
      context.on('close', () => log.warn('浏览器已关闭'));
    }
    page = context.pages()[0] || (await context.newPage());
    page.on('websocket', attach);
    page.on('console', (msg) => {
      if (msg.type() === 'error') log.debug('[page]', msg.text().slice(0, 160));
    });
    page.on('crash', () => log.error('页面崩溃，准备重载'));
    await page.goto(opts.roomUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    log.info('直播间页面已打开，等待推送信道建立…');
  }

  return {
    kind: 'cdp',
    async start() {
      if (!opts.roomUrl) throw new Error('source.cdp.roomUrl 未配置（形如 https://live.douyin.com/123456789）');
      stopped = false;
      await openPage();
      onStatus?.(status());

      // 看门狗：抖音会静默断流（页面还在，帧没了），超过 90 秒没有帧就重载一次
      watchdog = setInterval(async () => {
        if (stopped || !page) return;
        const idle = stats.lastFrameAt ? Date.now() - stats.lastFrameAt : 0;
        if (idle > 90_000) {
          stats.reloads++;
          log.warn(`已有 ${Math.round(idle / 1000)}s 没收到推送帧，重载页面`);
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
            stats.lastFrameAt = Date.now();
          } catch (err) {
            log.error('重载失败：', err?.message);
          }
        }
        onStatus?.(status());
      }, 30_000);
    },
    async stop() {
      stopped = true;
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      try {
        await context?.close();
      } catch (err) {
        log.debug('关闭浏览器时出错：', err?.message);
      }
      context = null;
      page = null;
      onStatus?.(status());
    },
    status,
  };
}
