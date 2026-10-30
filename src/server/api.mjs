/**
 * JSON 接口。给管控台用，也方便你直接用 curl 测。
 *
 * 写操作（POST）在配置了 server.adminToken 时要求带 `x-admin-token` 头；
 * 默认只监听 127.0.0.1，所以本地单人使用可以不配。
 */
import { sendJson, readBody } from './http.mjs';
import { patch as patchConfig, get as getConfig } from '../config.mjs';
import { recentLogs } from '../log.mjs';
import { MOTIONS } from '../reaction/behavior.mjs';
import { TIERS } from '../events.mjs';
import { stageVersion } from './version.mjs';

const WRITE_PATHS = new Set(['/api/manual', '/api/config', '/api/source']);

/** 给前端看的配置：整份都发，唯独把管理口令摘掉。 */
function publicConfig(cfg) {
  const clone = structuredClone(cfg);
  if (clone.server) delete clone.server.adminToken;
  return clone;
}

export function createApi({ runtime, brain, catalog, bus }) {
  async function handle(req, res, url) {
    // 每请求取一次：director/hub/source 是启动过程中逐步挂上去的，不能提前解构
    const { director, hub, source } = runtime;
    const cfg = getConfig();

    if (req.method === 'POST' && WRITE_PATHS.has(url.pathname) && cfg.server.adminToken) {
      if (req.headers['x-admin-token'] !== cfg.server.adminToken) {
        sendJson(res, 401, { ok: false, error: '缺少或错误的 x-admin-token' });
        return true;
      }
    }

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/stage-version': {
        sendJson(res, 200, { ok: true, version: stageVersion() });
        return true;
      }
      case 'GET /api/stats': {
        sendJson(res, 200, { ok: true, stats: runtime.stats?.snapshot() ?? null });
        return true;
      }
      case 'GET /api/state': {
        sendJson(res, 200, {
          ok: true,
          state: director.state,
          source: source?.status() ?? null,
          brain: brain.stats(),
          hub: hub.counts,
          config: publicConfig(cfg),
        });
        return true;
      }

      case 'GET /api/logs': {
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 150);
        sendJson(res, 200, { ok: true, logs: recentLogs(limit) });
        return true;
      }

      case 'GET /api/events': {
        const limit = Math.min(200, Number(url.searchParams.get('limit')) || 60);
        sendJson(res, 200, { ok: true, events: bus.recent(limit) });
        return true;
      }

      case 'GET /api/catalog': {
        sendJson(res, 200, {
          ok: true,
          motions: MOTIONS,
          tiers: TIERS.map((t) => ({ tier: t.tier, key: t.key, label: t.label, min: t.min, max: t.max === Infinity ? null : t.max })),
          effects: ['hearts', 'bubbles', 'splash', 'confetti', 'fireworks', 'stars'],
          moods: ['neutral', 'happy', 'excited', 'love', 'shy', 'playful', 'thinking', 'confused', 'alert', 'sad', 'grumpy', 'dizzy'],
        });
        return true;
      }

      case 'POST /api/manual': {
        const body = await readBody(req);
        const result = await director.manual(body.kind, body);
        sendJson(res, result.ok ? 200 : 400, result);
        return true;
      }

      case 'POST /api/config': {
        const body = await readBody(req);
        const result = await patchConfig(body.patch ?? body);
        // 改完立刻把新的限制推到运行中的组件
        if (result.applied['interaction.minIntervalMs'] || result.applied['interaction.maxPerMinute'] || result.applied['interaction.minScore']) {
          director.selector.setOptions(getConfig().interaction);
        }
        if (result.applied['reaction.cooldownMs'] || result.applied['reaction.maxPerMinute']) {
          director.queue.setOptions(getConfig().reaction);
        }
        if (result.applied['brain.llm.maxCallsPerMinute'] || result.applied['brain.llm.maxCallsPerDay']) {
          brain.setLimits(getConfig().brain.llm);
        }
        hub.broadcastAdmin({ type: 'config', data: getConfig() });
        sendJson(res, 200, { ok: true, ...result });
        return true;
      }

      case 'POST /api/source': {
        const body = await readBody(req);
        const action = body.action ?? 'restart';
        if (!source) {
          sendJson(res, 400, { ok: false, error: '当前没有可用的弹幕源' });
          return true;
        }
        if (action === 'stop') await source.stop();
        else {
          await source.stop();
          await source.start();
        }
        sendJson(res, 200, { ok: true, status: source.status() });
        return true;
      }

      default:
        return false;
    }
  }

  return { handle };
}
