/**
 * 舞台控制器：把服务端来的指令翻译成「鲸鱼娘真的动起来」。
 *
 * 渲染本身交给 vendored 的 pet.js（成熟实现：Live2D 加载、44 组参数表情、
 * 动作混合、眨眼、视线、气泡）。这一层只做三件事：
 *   1. 用正确的尺寸/位置把它挂进 OBS 画面；
 *   2. 把 act / effect / feed 指令翻译成对 window.DSHPet 的调用；
 *   3. 在它之上叠特效、横幅、弹幕流水。
 *
 * 之所以坚持用它的 act()：气泡、口型、爱心粒子、动作起停都在同一个时序里，
 * 自己拼一遍 setReaction + playMotion 会出现「话说完了嘴还在动」这类错位。
 */
import { createFx } from './effects.js';
import { createStageAudio } from './audio.js';
import { createGameUi } from './game.js';

const params = new URLSearchParams(location.search);
const showFeed = params.get('feed') !== '0';
const showHint = params.get('hint') !== '0';
const corner = params.get('corner') || 'br';

const el = {
  feed: document.getElementById('feed'),
  banner: document.getElementById('banner'),
  fallback: document.getElementById('fallback-sub'),
  hint: document.getElementById('hint'),
  canvas: document.getElementById('fx-canvas'),
};

const fx = createFx(el.canvas);

// 音频通道：send 里引用了后面才初始化的 ws；调用发生在连接建立之后，所以安全
const audio = createStageAudio({
  send: (m) => {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
    } catch {
      /* 断线时丢掉，靠服务端超时兜底 */
    }
  },
});
fx.resize();
addEventListener('resize', () => fx.resize());

// 给验收脚本 / 控制台留一个观察口（只读，不参与逻辑）
const gameUi = createGameUi();
// 背景是可选的：默认透明（OBS 里好叠），?bg=gradient 才画浅色渐变+气泡
if (new URLSearchParams(location.search).get('bg') === 'gradient') {
  document.body.classList.add('bg-gradient');
}

window.__DSH_STAGE__ = { audio, fx, gameUi };

// 版本自检：OBS 会缓存页面，代码改了它不重载。这里每 10 秒问一次，
// 发现服务端版本变了就自己刷新——省得每次都要手动右键「刷新」。
let knownVersion = null;
async function checkVersion() {
  try {
    const r = await fetch('/api/stage-version', { cache: 'no-store' });
    const { version } = await r.json();
    if (!version) return;
    if (knownVersion === null) {
      knownVersion = version;
      return;
    }
    if (version !== knownVersion) {
      console.info('[stage] 检测到新版本，自动刷新');
      location.reload();
    }
  } catch {
    /* 服务没起来就下次再试 */
  }
}
checkVersion();
setInterval(checkVersion, 10_000);

// 开场说明文案由服务端配置决定（送什么礼物 → 能玩什么）
(async () => {
  try {
    const st = await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json());
    const tip = st?.config?.games?.idleTip;
    const el = document.getElementById('idle-tip');
    if (el) el.textContent = tip || '🎁 送礼物可以开一局猜词';
  } catch {}
})();

const errors = [];
addEventListener('error', (e) => errors.push(String(e.message || e)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.message || e.reason)));

// ————————————————————————————————————————————————————————
// 弹幕流水
// ————————————————————————————————————————————————————————
const feedLines = [];
const FEED_MAX = 5;
function addFeed(user, text) {
  if (!showFeed) return;
  const line = document.createElement('div');
  line.className = 'line';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = user;
  const what = document.createElement('span');
  what.className = 'what';
  what.textContent = text;
  line.append(who, what);
  el.feed.prepend(line);
  feedLines.push(line);
  while (feedLines.length > FEED_MAX) {
    const old = feedLines.shift();
    old.style.opacity = '0';
    setTimeout(() => old.remove(), 700);
  }
  // 单条自己也会老去，避免静止画面被旧弹幕占满
  setTimeout(() => {
    line.style.opacity = '0';
    setTimeout(() => {
      line.remove();
      const i = feedLines.indexOf(line);
      if (i >= 0) feedLines.splice(i, 1);
    }, 700);
  }, 22_000);
}

// ————————————————————————————————————————————————————————
// 横幅 & 兜底字幕
// ————————————————————————————————————————————————————————
let bannerTimer = null;
function showBanner(text) {
  el.banner.textContent = text;
  el.banner.classList.remove('show');
  void el.banner.offsetWidth; // 强制重排，让动画能重播
  el.banner.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.banner.classList.remove('show'), 3000);
}

let fallbackTimer = null;
function showFallback(text, ms = 3000) {
  el.fallback.textContent = text;
  el.fallback.classList.add('show');
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => el.fallback.classList.remove('show'), ms);
}

let hintHidden = false;
function dismissHint() {
  if (hintHidden || !showHint) return;
  hintHidden = true;
  el.hint.classList.add('hide');
}

// ————————————————————————————————————————————————————————
// 启动：先定尺寸，再加载 pet.js
// ————————————————————————————————————————————————————————
function pickHeight() {
  const fromQuery = Number(params.get('h'));
  if (fromQuery > 0) return Math.max(240, Math.min(2000, fromQuery));
  // 默认按视口的九成算，OBS 1080p 下就是 ~970px
  return Math.max(320, Math.min(1400, Math.round(Math.min(innerHeight * 0.92, innerWidth * 1.05))));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.head.appendChild(s);
  });
}

async function bootPet() {
  const height = pickHeight();
  window.__DSH_PET_BOOT__ = {
    config: {
      height,
      corner,
      // 直播时不该一直盯着鼠标（鼠标在 OBS 里是不存在的），给一个稳定的视线
      lookAtCursor: false,
      talkMouth: true,
      // 24 小时才「睡」，等于永不自动睡
      sleepAfterMs: 86_400_000,
      bubbleTtlMs: 0,
      maxWidthRatio: 1,
    },
  };
  await loadScript('/dsh-pet/pet.patched.js');
  // 等它把模型加载完（内部是异步 fetch）。最多等 25 秒。
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (window.DSHPet?.state?.modelSize) return { height, ready: true };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { height, ready: false, err: window.__DSHPetError || '超时未就绪' };
}

// ————————————————————————————————————————————————————————
// 指令执行
// ————————————————————————————————————————————————————————
function petAct(m) {
  const pet = window.DSHPet;
  if (!pet) return false;
  if (typeof pet.act === 'function') {
    pet.act({
      mood: m.mood,
      motion: m.motion,
      props: m.props || [],
      line: m.line || undefined,
      heart: Boolean(m.heart),
      ms: m.ms || 3000,
      exclusive: Boolean(m.exclusive),
    });
    return true;
  }
  // 补丁没打上时的退路：动作和表情照给，字幕自己画
  if (m.mood || (m.props && m.props.length)) pet.setReaction({ mood: m.mood, props: m.props || [], ms: m.ms || 3000 });
  if (m.motion) pet.playMotion(m.motion);
  if (m.line) showFallback(m.line, m.ms || 3000);
  return false;
}

function handle(msg) {
  switch (msg.type) {
    case 'act':
      dismissHint();
      petAct(msg);
      if (msg.tier >= 4) showBanner(`🎁 ${msg.tier === 5 ? '重礼' : '大礼'}降临！`);
      break;
    case 'say':
      dismissHint();
      if (!petAct({ line: msg.text, ms: msg.ms || 2600 })) showFallback(msg.text, msg.ms || 2600);
      break;
    case 'effect':
      fx.spawn(msg.name, msg.intensity ?? 0.6);
      break;
    case 'feed':
      addFeed(msg.user, msg.text);
      break;
    case 'gift':
      if (msg.tier >= 3) showBanner(`${msg.gift} ×${msg.count}　${msg.user}`);
      break;
    case 'game':
      gameUi.handle(msg);
      break;
    case 'audio':
      audio.handle(msg);
      break;
    case 'motion':
      window.DSHPet?.playMotion?.(msg.name);
      break;
    case 'base':
      window.DSHPet?.setBase?.(msg.mood || 'neutral', msg.props || []);
      break;
    case 'reply':
      // 回复内容已经通过 act 上屏了，这里只留一份痕迹给管控台
      break;
    default:
      break;
  }
}

// ————————————————————————————————————————————————————————
// WebSocket
// ————————————————————————————————————————————————————————
let ws = null;
let retry = 0;
let petInfo = { ready: false };

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=stage`);

  ws.onopen = () => {
    retry = 0;
    ws.send(JSON.stringify({ type: 'ready' }));
    reportStatus();
  };

  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      dismissHint();
      // 断线重连/中途刷新时，把最近的状态补回来（否则游戏进行中刷新会白屏）
      for (const item of msg.recent ?? []) {
        try { handle(item); } catch {}
      }
      return;
    }
    handle(msg);
  };

  ws.onclose = () => {
    retry = Math.min(10, retry + 1);
    setTimeout(connect, Math.min(8000, 500 * retry));
  };

  ws.onerror = () => ws?.close();
}

function reportStatus() {
  if (!ws || ws.readyState !== 1) return;
  const pet = window.DSHPet;
  ws.send(
    JSON.stringify({
      type: 'stage-status',
      data: {
        ready: petInfo.ready,
        // 旧版页面没有 #game 元素，服务端发游戏消息也画不出来
        hasGame: Boolean(document.getElementById('game')),
        hasAudio: Boolean(window.__DSH_STAGE__?.audio),
        height: petInfo.height ?? null,
        modelSize: pet?.state?.modelSize ?? null,
        mood: pet?.state?.mood ?? null,
        fxCount: fx.count,
        errors: errors.slice(-5),
      },
    }),
  );
}

// ————————————————————————————————————————————————————————
// 起
// ————————————————————————————————————————————————————————
(async () => {
  petInfo = await bootPet();
  if (!petInfo.ready) {
    el.hint.textContent = `模型没加载好：${petInfo.err ?? '未知原因'}`;
    el.hint.style.color = '#ff8a9c';
  }

  connect();
  setInterval(reportStatus, 5000);
})();
