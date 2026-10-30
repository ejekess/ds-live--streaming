/**
 * 极简 HTTP 层：静态文件 + JSON 接口。
 *
 * 不引框架是刻意的——这个进程要长时间跑在直播现场，依赖越少越不容易在
 * 半夜三点出问题；所有路由都是显式的，出问题看一眼就知道去哪儿找。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../log.mjs';

const log = logger('http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.moc3': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

export async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * 静态文件。`mounts` 是 [{ prefix, root }]，按前缀最长匹配。
 * 路径穿越在这里挡掉：解析后的绝对路径必须仍在 root 里面。
 */
export async function serveStatic(req, res, mounts, pathname) {
  const mount = mounts
    .filter((m) => pathname === m.prefix || pathname.startsWith(m.prefix.endsWith('/') ? m.prefix : m.prefix + '/'))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];

  let rel;
  if (mount) {
    rel = pathname.slice(mount.prefix.length).replace(/^\/+/, '') || mount.index || 'index.html';
    rel = path.join(mount.root, rel);
  } else {
    rel = path.join(mounts[0].root, pathname.replace(/^\/+/, ''));
  }

  const abs = path.resolve(rel);
  const allowedRoots = mounts.map((m) => path.resolve(m.root));
  if (!allowedRoots.some((root) => abs === root || abs.startsWith(root + path.sep))) {
    sendText(res, 403, 'forbidden');
    return true;
  }

  try {
    const info = await stat(abs);
    if (info.isDirectory()) {
      const index = path.join(abs, 'index.html');
      return serveStatic(req, res, [{ prefix: '/', root: abs, index: 'index.html' }], '/index.html');
    }
    const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      // no-store 而不是 no-cache：调样式时被浏览器缓存坑过，
      // 直播现场宁可多传几 KB，也不要「改了没生效」这种排查半小时的假象
      'cache-control': 'no-store',
    });
    createReadStream(abs).pipe(res);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    log.error('读文件失败：', err);
    sendText(res, 500, 'internal error');
    return true;
  }
}
