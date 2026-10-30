/**
 * 渲染器工厂：按配置选实现，上层只认 render({song}) 一个方法。
 * 换 RVC / 换占位，业务代码一行不用改。
 */
import { createPlaceholderRenderer } from './placeholder.mjs';
import { createRvcRenderer } from './rvc.mjs';

export function createRenderer(cfg) {
  if (cfg.renderer === 'rvc') {
    return createRvcRenderer({
      python: cfg.rvc?.python ?? 'python',
      script: cfg.rvc?.script,
      cwd: cfg.rvc?.cwd,
      renderedDir: cfg.renderedDir,
      timeoutMs: cfg.renderTimeoutMs,
      extraEnv: cfg.rvc?.env ?? {},
    });
  }
  return createPlaceholderRenderer({
    renderedDir: cfg.renderedDir,
    delayMs: cfg.placeholder?.delayMs ?? 0,
    seconds: cfg.placeholder?.seconds ?? 6,
  });
}
