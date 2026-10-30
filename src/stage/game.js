/**
 * 猜词游戏的舞台呈现。
 *
 * 视觉上就是三层 DOM：
 *   1. 一张「举在身后」的词板（背面朝外，写着 ?）
 *   2. 底部四个选项卡片
 *   3. 一条倒计时
 *
 * 为什么不画在 Live2D 里：现有模型没有「举牌」道具，硬做要等美术资源。
 * DOM 层的好处是能立刻做出来，而且揭晓时的翻转、统计条、高亮都好控制。
 */

const KEYS = ['A', 'B', 'C', 'D'];

/** 每个游戏阶段都显示这一条，观众不用记规则 */
const RULE_TEXT = {
  // 反向：观众藏着答案，她来问
  reverse: [
    '反向猜词 · 答案在你们手里，我来问',
    '① 选题：发 1 / 2 / 3，挑一个想让我问的',
    '② 回答：发 1-4 选答案，发 0 表示不确定',
  ].join('\n'),
  // 正向：她描述，观众猜
  forward: [
    '正向猜词 · 我来描述，你们猜',
    '发 A / B / C / D（或 1-4）选答案',
  ].join('\n'),
};

export function createGameUi() {
  const root = document.getElementById('game');
  const face = root?.querySelector('.game-card-face');
  const meta = root?.querySelector('.game-card-meta');
  const bar = root?.querySelector('.game-bar i');
  const opts = root?.querySelector('.game-options');
  const result = root?.querySelector('.game-result');
  const hint = root?.querySelector('.game-hint');
  const rule = root?.querySelector('.game-rule');
  const idleTip = document.getElementById('idle-tip');

  let timer = null;
  let counts = null;

  function show(on = true) {
    root?.classList.toggle('on', on);
  }

  function clearTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function startBar(ms) {
    clearTimer();
    if (!bar) return;
    const t0 = performance.now();
    bar.style.width = '100%';
    timer = setInterval(() => {
      const left = Math.max(0, 1 - (performance.now() - t0) / ms);
      bar.style.width = `${(left * 100).toFixed(1)}%`;
      if (left <= 0) clearTimer();
    }, 100);
  }

  function renderOptions(options, correctKey = null) {
    if (!opts) return;
    opts.replaceChildren();
    for (const o of options) {
      const card = document.createElement('div');
      card.className = 'game-opt';
      card.dataset.key = o.key;
      if (correctKey && o.key === correctKey) card.classList.add('correct');
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = o.key;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = o.text;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = counts?.[o.key] ? String(counts[o.key]) : '';
      card.append(k, t, n);
      opts.append(card);
    }
  }

  return {
    handle(msg) {
      switch (msg.action) {
        case 'intro': {
          counts = null;
          if (rule) rule.textContent = RULE_TEXT.forward;
          idleTip?.classList.add('hidden');
          show(true);
          root?.classList.remove('revealed');
          if (face) face.textContent = '?';
          if (meta) meta.textContent = `${msg.category} · ${msg.length} 个字`;
          if (result) result.textContent = '';
          if (hint) hint.textContent = '';
          if (opts) opts.replaceChildren();
          if (bar) bar.style.width = '0%';
          clearTimer();
          break;
        }

        // 页面在半局中途接入：按当前阶段把板子重建出来
        case 'resync': {
          show(true);
          document.body.classList.add('gaming');
          if (face) face.textContent = msg.word ?? '?';
          if (meta) meta.textContent = `第 ${msg.round}/${msg.totalRounds} 轮 · ${msg.category ?? ''} · ${msg.length ?? '?'} 个字`;
          if (hint) hint.textContent = msg.phase === 'ask' || msg.phase === 'answer' ? (msg.question ?? '') : '选一个想让我问的';
          if (msg.phase === 'reveal' || msg.phase === 'done') root?.classList.add('revealed');
          break;
        }

        case 'hint': {
          if (hint) hint.textContent = msg.text;
          break;
        }

        case 'options': {
          renderOptions(msg.options ?? []);
          if (result) result.textContent = '选一个：发 A / B / C / D';
          startBar(msg.ms ?? 45_000);
          break;
        }

        case 'vote': {
          if (!opts) break;
          const card = opts.querySelector(`[data-key="${msg.key}"]`);
          if (!card) break;
          const n = card.querySelector('.n');
          if (n) n.textContent = String(Number(n.textContent || 0) + 1);
          card.classList.add('pulse');
          setTimeout(() => card.classList.remove('pulse'), 260);
          break;
        }

        // 开场：整块横幅亮一下，别让问题突然砸出来
        case 'start': {
          show(true);
          document.body.classList.add('gaming');
          root?.classList.add('starting');
          idleTip?.classList.add('hidden');
          if (face) face.textContent = '?';
          if (meta) meta.textContent = `${msg.category} · ${msg.length} 个字 · 共 ${msg.rounds} 轮`;
          if (hint) hint.textContent = msg.giver ? `${msg.giver} 解锁了一局猜词` : '开一局猜词';
          if (rule) rule.textContent = RULE_TEXT.reverse;
          if (result) result.textContent = '准备开始…';
          if (opts) opts.replaceChildren();
          break;
        }

        // —— 反向模式：观众选题 → 她问 → 观众答 ——
        case 'pick': {
          counts = null;
          root?.classList.remove('starting');
          document.body.classList.add('gaming');
          show(true);
          root?.classList.remove('revealed');
          if (face) face.textContent = '?';
          if (meta) meta.textContent = `第 ${msg.round}/${msg.totalRounds} 轮 · ${msg.category} · ${msg.length} 个字`;
          // 反向模式：观众是「幽灵」，词板正面朝他们；她拿不到这个词
          if (msg.word && face) {
            face.textContent = msg.word;
            face.classList.add('word');
          }
          if (hint) hint.textContent = '你们知道答案，随便挑一个让我问';
          if (rule) rule.textContent = RULE_TEXT.reverse;
          idleTip?.classList.add('hidden');
          if (result) result.textContent = '';
          if (bar) bar.style.width = '0%';
          clearTimer();
          renderOptions(msg.options ?? []);
          break;
        }

        case 'ask': {
          if (hint) hint.textContent = msg.question;
          if (opts) {
            for (const card of opts.children) card.classList.add('dim');
          }
          if (result) result.textContent = '';
          break;
        }

        case 'answer': {
          if (hint) hint.textContent = msg.question;
          if (result) result.textContent = '发 1 / 2 / 3 / 4 选一个，0 表示不确定';
          renderOptions(msg.options ?? []);
          startBar(msg.ms ?? 15_000);
          break;
        }

        case 'result': {
          clearTimer();
          const c = msg.counts ?? {};
          for (const card of opts?.children ?? []) {
            card.classList.remove('dim', 'correct');
            const n = card.querySelector('.n');
            const key = card.dataset.key;
            if (n) n.textContent = c[key] ? String(c[key]) : '';
            if (msg.verdict?.key === key) card.classList.add('correct');
          }
          if (result) {
            result.textContent = msg.verdict?.text ? `大家说：${msg.verdict.text}` : '大家说法都不一样';
          }
          break;
        }

        case 'reveal': {
          clearTimer();
          if (msg.word) {
            // 反向模式：系统揭晓答案，她也是这时候才知道
            if (face) face.textContent = msg.word;
            if (hint) hint.textContent = msg.category ? `原来它是${msg.category}` : '';
            if (result) result.textContent = `答案是${msg.word}`;
            if (bar) bar.style.width = '0%';
            root?.classList.add('revealed');
            for (const card of opts?.children ?? []) card.classList.remove('dim');
            break;
          }
          counts = msg.counts ?? {};
          renderOptions(msg.options ?? [], null);
          // 用当前选项把正确答案标绿
          const answer = msg.answer;
          for (const card of opts?.children ?? []) {
            if (card.querySelector('.t')?.textContent === answer) card.classList.add('correct');
            const n = card.querySelector('.n');
            const key = card.dataset.key;
            if (n) n.textContent = counts[key] ? String(counts[key]) : '';
          }
          if (face) face.textContent = answer ?? '';
          root?.classList.add('revealed');
          if (result) {
            const who = msg.firstCorrect ? `${msg.firstCorrect} 最快` : msg.correctCount ? `${msg.correctCount} 人` : '没人';
            result.textContent = `答案：${answer} · ${who}猜对`;
          }
          break;
        }

        case 'end': {
          clearTimer();
          document.body.classList.remove('gaming');
          idleTip?.classList.remove('hidden');
          if (rule) rule.textContent = '';
          if (bar) bar.style.width = '0%';
          setTimeout(() => show(false), 2600);
          break;
        }

        default:
          break;
      }
    },
    hide() {
      clearTimer();
      show(false);
    },
  };
}

export { KEYS };
