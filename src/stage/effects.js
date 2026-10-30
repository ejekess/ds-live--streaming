/**
 * 舞台特效层。
 *
 * 为什么自己写而不用现成粒子库：这个层要跑在 OBS 的浏览器源里，长时间不关，
 * 所以硬性要求是「没粒子的时候一帧都不算」。现成库大多常驻 RAF，跑一整天会
 * 白白吃掉渲染线程，OBS 掉帧最先怪到这一层。这里所有粒子归零就停表。
 *
 * 六种预设对应五档打赏：hearts / bubbles / splash / confetti / fireworks / stars。
 */

const TAU = Math.PI * 2;

export function createFx(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0;
  let h = 0;
  let raf = null;
  let last = 0;
  /** @type {Array<object>} */
  let parts = [];
  const MAX_PARTS = 420;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    w = Math.max(1, rect.width);
    h = Math.max(1, rect.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function loop(now) {
    const dt = Math.min(48, now - (last || now));
    last = now;
    ctx.clearRect(0, 0, w, h);

    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      if (p.life >= p.ttl) {
        parts.splice(i, 1);
        continue;
      }
      p.vy += (p.gravity ?? 0) * (dt / 16.67);
      p.vx *= p.drag ?? 0.995;
      p.vy *= p.drag ?? 0.995;
      p.x += p.vx * (dt / 16.67);
      p.y += p.vy * (dt / 16.67);
      p.rot += p.vr * (dt / 16.67);

      const k = 1 - p.life / p.ttl;
      draw(p, k);
    }

    if (parts.length) {
      raf = requestAnimationFrame(loop);
    } else {
      ctx.clearRect(0, 0, w, h);
      raf = null;
      last = 0;
    }
  }

  function ensureLoop() {
    if (!raf) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  }

  function draw(p, k) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, k * (p.fadePow ?? 1)));
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    switch (p.kind) {
      case 'heart':
        drawHeart(ctx, p.size, p.color);
        break;
      case 'circle':
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, TAU);
        ctx.fillStyle = p.color;
        ctx.fill();
        break;
      case 'rect':
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size * 0.5, -p.size * 0.28, p.size, p.size * 0.56);
        break;
      case 'star':
        drawStar(ctx, p.size, p.color);
        break;
      case 'drop':
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size * 0.62, p.size, 0, 0, TAU);
        ctx.fillStyle = p.color;
        ctx.fill();
        break;
      default:
        break;
    }
    ctx.restore();
  }

  function drawHeart(c, s, color) {
    c.beginPath();
    c.moveTo(0, s * 0.32);
    c.bezierCurveTo(s * 0.62, -s * 0.22, s * 0.3, -s * 0.86, 0, -s * 0.4);
    c.bezierCurveTo(-s * 0.3, -s * 0.86, -s * 0.62, -s * 0.22, 0, s * 0.32);
    c.closePath();
    c.fillStyle = color || '#ff6aa8';
    c.fill();
  }

  function drawStar(c, s, color) {
    c.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = i % 2 === 0 ? s : s * 0.36;
      const a = (i / 8) * TAU - Math.PI / 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.closePath();
    c.fillStyle = color;
    c.fill();
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function add(part) {
    if (parts.length >= MAX_PARTS) parts.splice(0, 24);
    parts.push({
      life: 0,
      rot: rand(0, TAU),
      vr: rand(-0.06, 0.06),
      drag: 0.995,
      gravity: 0,
      fadePow: 1,
      ...part,
    });
  }

  /** 各预设。intensity 0..1 控制数量与尺寸，档位越高越夸张。 */
  const PRESETS = {
    hearts(n) {
      for (let i = 0; i < n; i++) {
        add({
          kind: 'heart',
          x: rand(w * 0.15, w * 0.85),
          y: h + rand(0, 80),
          vx: rand(-0.5, 0.5),
          vy: rand(-2.6, -1.2),
          size: rand(10, 22),
          ttl: rand(2400, 4200),
          color: pick(['#ff6aa8', '#ff8fb8', '#ff4d88']),
        });
      }
    },
    bubbles(n) {
      for (let i = 0; i < n; i++) {
        add({
          kind: 'circle',
          x: rand(w * 0.2, w * 0.8),
          y: h + rand(0, 60),
          vx: rand(-0.4, 0.4),
          vy: rand(-1.8, -0.8),
          size: rand(6, 20),
          ttl: rand(2200, 4000),
          color: `rgba(150, 220, 255, ${rand(0.35, 0.8).toFixed(2)})`,
        });
      }
    },
    splash(n) {
      // 从画面中下方往上喷，模拟「喷水」动作
      const cx = w * 0.58;
      const cy = h * 0.72;
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI * 0.82, -Math.PI * 0.18);
        const speed = rand(6, 15);
        add({
          kind: 'drop',
          x: cx + rand(-40, 40),
          y: cy,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          size: rand(4, 11),
          ttl: rand(700, 1400),
          gravity: 0.42,
          drag: 0.99,
          color: `rgba(140, 215, 255, ${rand(0.5, 0.95).toFixed(2)})`,
        });
      }
    },
    confetti(n) {
      for (let i = 0; i < n; i++) {
        add({
          kind: 'rect',
          x: rand(0, w),
          y: rand(-160, -10),
          vx: rand(-1.4, 1.4),
          vy: rand(1.8, 5),
          size: rand(7, 15),
          ttl: rand(2600, 4600),
          gravity: 0.035,
          vr: rand(-0.22, 0.22),
          color: pick(['#ffd166', '#ff6aa8', '#7c5cff', '#4dd6a8', '#8fd3ff', '#ff9f45']),
        });
      }
    },
    fireworks(n) {
      const bursts = Math.max(1, Math.round(n / 40));
      for (let b = 0; b < bursts; b++) {
        const cx = rand(w * 0.2, w * 0.8);
        const cy = rand(h * 0.12, h * 0.45);
        const hue = pick(['#ffd166', '#ff6aa8', '#8fd3ff', '#a78bfa', '#4dd6a8']);
        for (let i = 0; i < 42; i++) {
          const a = (i / 42) * TAU + rand(-0.06, 0.06);
          const speed = rand(3.5, 9);
          add({
            kind: 'circle',
            x: cx,
            y: cy,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed,
            size: rand(2.5, 5.5),
            ttl: rand(900, 1600),
            gravity: 0.09,
            drag: 0.965,
            color: hue,
          });
        }
      }
    },
    stars(n) {
      for (let i = 0; i < n; i++) {
        add({
          kind: 'star',
          x: rand(0, w),
          y: rand(0, h * 0.7),
          vx: rand(-0.3, 0.3),
          vy: rand(-1.1, -0.3),
          size: rand(7, 17),
          ttl: rand(1400, 2800),
          color: pick(['#ffe9a8', '#fff6d8', '#ffd166']),
        });
      }
    },
  };

  return {
    resize,
    /** @param {string} name @param {number} intensity 0..1 */
    spawn(name, intensity = 0.6) {
      const preset = PRESETS[name];
      if (!preset) return;
      if (!w || !h) resize();
      const base = { hearts: 22, bubbles: 26, splash: 60, confetti: 50, fireworks: 30, stars: 14 }[name] ?? 20;
      preset(Math.round(base * Math.max(0.25, Math.min(1.6, intensity))));
      ensureLoop();
    },
    /** 画面上所有粒子清零（切场景/重置时用）。 */
    clear() {
      parts = [];
      ctx.clearRect(0, 0, w, h);
    },
    get count() {
      return parts.length;
    },
  };
}
