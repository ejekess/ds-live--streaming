/**
 * 媒体路由：把磁盘上的音频映射成浏览器可访问的 URL。
 *
 * 为什么不用 `/media?path=绝对路径`：那是路径穿越的经典写法。
 * 这里只允许白名单里的三个根目录，且 URL 里只出现相对路径。
 */
import path from 'node:path';

/**
 * @param {{prefix:string, root:string}[]} mounts
 */
export function createMedia(mounts) {
  const resolved = mounts
    .filter((m) => m && m.root)
    .map((m) => ({ prefix: m.prefix, root: path.resolve(m.root) }))
    .sort((a, b) => b.root.length - a.root.length);

  return {
    mounts: resolved,

    /** 绝对路径 → URL；不在任何挂载点下则返回 null。 */
    url(file) {
      if (!file) return null;
      const abs = path.resolve(file);
      for (const m of resolved) {
        if (abs === m.root || abs.startsWith(m.root + path.sep)) {
          const rel = path.relative(m.root, abs).split(path.sep).map(encodeURIComponent).join('/');
          return `${m.prefix}/${rel}`;
        }
      }
      return null;
    },

    /** 仅供服务端解析静态请求时防穿越用。 */
    roots() {
      return resolved.map((m) => m.root);
    },
  };
}
