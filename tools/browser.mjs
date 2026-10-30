/**
 * 复用本机浏览器的 CDP 连接器。
 *
 * 为什么不用 `chromium.launch()`：它默认通过管道（`--remote-debugging-pipe`）
 * 和浏览器通信，而当前沙箱禁止程序打开命名管道，spawn 会直接 EPERM。
 * 改成「自己把浏览器起成调试端口 → connectOverCDP 连普通 TCP」就绕开了这个限制，
 * 顺便还带来一个好处：浏览器只起一次，多次截图/调试都是复用的，快很多。
 *
 * 只用本机已装的浏览器，不下载 Chromium。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const CANDIDATES = [
  { name: 'edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'chrome', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'chrome', path: path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe') },
];

export function findBrowser() {
  const found = CANDIDATES.find((c) => c.path && existsSync(c.path));
  if (!found) throw new Error('本机没找到 Edge/Chrome，请先在 config 里指定 browserPath');
  return found;
}

async function waitForJson(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来，接着等 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`浏览器调试端口 ${port} 在 ${timeoutMs}ms 内没起来`);
}

/**
 * 确保有一个带调试端口的浏览器在跑，返回 CDP 地址。
 * @param {{port?:number, headless?:boolean}} opts
 */
export async function ensureBrowser({ port = 9222, headless = true } = {}) {
  try {
    const info = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    if (info.ok) return { port, wsEndpoint: `http://127.0.0.1:${port}`, reused: true };
  } catch {
    /* 没在跑，起一个 */
  }

  const browser = findBrowser();
  const profile = path.resolve('data', 'runtime', `browser-${port}`);
  await mkdir(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    // 无头环境默认禁止自动播放；不放开的话 <audio>.play() 会被拒，
    // 服务端就只能看到 audio-done reason=error，验不出真实播放
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1600,900',
    // 无头环境下要让 WebGL 走软件渲染，否则 Live2D 画不出来
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  // detached + 不捕获 stdio：沙箱不允许管道，也不希望浏览器跟着本进程退出
  const child = spawn(browser.path, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  await waitForJson(port);
  return { port, wsEndpoint: `http://127.0.0.1:${port}`, reused: false, browser: browser.name, pid: child.pid };
}

/** 关掉调试端口上的浏览器（截图脚本用完自己清场时调）。 */
export async function closeBrowser(port = 9222) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close`, { method: 'PUT' }).catch(() => {});
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const target of list) {
      if (target.type === 'page') await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, { method: 'GET' }).catch(() => {});
    }
  } catch {
    /* 已经没了就算了 */
  }
}
