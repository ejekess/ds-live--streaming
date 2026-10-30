/**
 * 管控台前端。
 *
 * 只用原生 DOM，不引框架——这个页面要能在直播现场的低配机器上秒开，
 * 并且一旦 JS 出错，整个直播间不会跟着挂。
 *
 * 一条纪律：所有来自直播间的文本（昵称、弹幕、礼物名）一律走 textContent，
 * 绝不拼进 innerHTML。弹幕里出现 `<img onerror=...>` 是很常见的事。
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const el = {
  subtitle: $('#subtitle'),
  stats: $('#stats'),
  stream: $('#stream'),
  lastPerf: $('#lastPerf'),
  lastReply: $('#lastReply'),
  queue: $('#queue'),
  logs: $('#logs'),
  srcStatus: $('#srcStatus'),
  cfgStatus: $('#cfgStatus'),
};

let catalog = { motions: [], tiers: [], effects: [], moods: [] };
let connected = false;

// ————————————————————————————————————————————————————————
// 小工具
// ————————————————————————————————————————————————————————
function elmrow(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
}

// ————————————————————————————————————————————————————————
// 顶部数字
// ————————————————————————————————————————————————————————
function statCard(label, value) {
  const box = elmrow('div', 'stat');
  box.append(elmrow('b', null, value), elmrow('span', null, label));
  return box;
}

function renderStats(state, source) {
  if (!state) return;
  el.stats.replaceChildren(
    statCard('在线人数', state.viewers || '—'),
    statCard('弹幕', state.comments || 0),
    statCard('礼物', state.gifts || 0),
    statCard('抖币', state.diamonds || 0),
    statCard('运行', fmtDuration(state.uptimeMs)),
  );

  const src = source ?? null;
  const kind = src?.kind ?? '—';
  const running = src?.running ? '接收中' : '已暂停';
  el.subtitle.textContent = `${connected ? '已连接' : '连接中断'} · 弹幕源：${kind}（${running}）${state.topGifter ? ` · 榜一 ${state.topGifter.name} ${state.topGifter.total} 币` : ''}`;
  if (el.srcStatus) el.srcStatus.textContent = `${kind} · ${running}`;

  // 队列
  const q = state.queue;
  if (q) {
    el.queue.replaceChildren(
      elmrow('div', 'line', `已演出 ${q.played} 次`),
      elmrow('div', 'line', `排队 ${q.pending} 条`),
      elmrow('div', 'line', q.playing ? `正在演：${q.playing}` : '空闲'),
      elmrow('div', 'line', `丢弃 ${q.dropped} · 插队 ${q.preempted}`),
    );
  }

  // 点歌队列
  const sg = state.songs;
  if (sg) {
    el.queue.append(elmrow('div', 'line', `点歌队列 ${sg.size ?? 0} 首 · 曲库 ${sg.library ?? 0} · ${sg.renderer ?? ''}`));
    for (const it of (sg.items ?? []).slice(0, 3)) {
      el.queue.append(elmrow('div', 'line', `· ${it.song}（${it.status}${it.who ? ' / ' + it.who : ''}）`));
    }
  }

  // 猜词状态
  const game = state.games;
  if (game) {
    el.queue.append(elmrow('div', 'line', `猜词：${game.active ? game.phase + ' · ' + game.votes + ' 票' : '空闲'}`));
  }

  // 最近演出
  const p = state.lastPerformance;
  if (p && p.line) {
    el.lastPerf.replaceChildren(
      elmrow('div', 'line', `档位 T${p.tier} · ${p.motion ?? '无动作'}`),
      elmrow('div', 'line', p.line),
    );
  }

  // 最近回复
  const r = state.lastReply;
  if (r && r.text) {
    const ask = elmrow('div', 'line', `${r.user}：${r.ask}`);
    const ans = elmrow('div', 'line', '');
    ans.append(elmrow('b', null, r.text), document.createTextNode(`（${r.source}）`));
    el.lastReply.replaceChildren(ask, ans);
  }
}

// ————————————————————————————————————————————————————————
// 事件流
// ————————————————————————————————————————————————————————
const MAX_ROWS = 120;

function pushRow({ cls, who, what, tag }) {
  const row = elmrow('div', `row-item ${cls ?? ''}`);
  row.append(elmrow('span', 'who', who), elmrow('span', 'what', what));
  if (tag) row.append(elmrow('span', 'tag', tag));
  el.stream.prepend(row);
  while (el.stream.childElementCount > MAX_ROWS) el.stream.lastElementChild.remove();
}

function onLiveEvent(ev) {
  if (!ev) return;
  if (ev.type === 'comment') pushRow({ who: ev.user?.name ?? '观众', what: ev.text ?? '' });
  else if (ev.type === 'gift') {
    pushRow({
      cls: 'gift',
      who: ev.user?.name ?? '观众',
      what: `送出 ${ev.giftName}${ev.count > 1 ? ` ×${ev.count}` : ''}`,
      tag: `${ev.totalDiamonds ?? 0} 币`,
    });
  } else if (ev.type === 'follow') pushRow({ cls: 'follow', who: ev.user?.name ?? '观众', what: '关注了直播间' });
}

// ————————————————————————————————————————————————————————
// 舞台指令回显（排查「到底推没推过去」）
// ————————————————————————————————————————————————————————
function onStageCmd(msg) {
  if (msg.type === 'act' && msg.line) {
    pushRow({ cls: 'stage', who: '舞台', what: `${msg.mood ?? ''} ${msg.motion ?? ''} ${msg.line}`, tag: `T${msg.tier ?? 0}` });
  }
}

// ————————————————————————————————————————————————————————
// 手动测试
// ————————————————————————————————————————————————————————
function buildTestButtons() {
  const tiers = catalog.tiers.length ? catalog.tiers : [
    { tier: 1, label: '小心意' },
    { tier: 2, label: '有份量' },
    { tier: 3, label: '挺大方' },
    { tier: 4, label: '大礼' },
    { tier: 5, label: '重礼' },
  ];
  const tierBox = $('#tierBtns');
  tierBox.replaceChildren(
    ...tiers.map((t) => {
      const btn = elmrow('button', 'btn tier');
      btn.append(document.createTextNode(`T${t.tier} `), elmrow('b', null, t.label));
      btn.onclick = async () => {
        const r = await post('/api/manual', { kind: 'gift', tier: t.tier, name: '测试观众', gift: `测试礼物T${t.tier}` });
        flash(btn, r.ok ? '已触发' : '失败');
      };
      return btn;
    }),
  );

  const motionBox = $('#motionBtns');
  motionBox.replaceChildren(
    ...(catalog.motions || []).map((name) => {
      const btn = elmrow('button', 'btn', `动作：${name}`);
      btn.onclick = async () => {
        const r = await post('/api/manual', { kind: 'motion', name });
        flash(btn, r.ok ? '已播' : '失败');
      };
      return btn;
    }),
  );

  const effectBox = $('#effectBtns');
  effectBox.replaceChildren(
    ...(catalog.effects || []).map((name) => {
      const btn = elmrow('button', 'btn', `特效：${name}`);
      btn.onclick = async () => {
        const r = await post('/api/manual', { kind: 'effect', name });
        flash(btn, r.ok ? '已放' : '失败');
      };
      return btn;
    }),
  );
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = old;
    btn.disabled = false;
  }, 900);
}

// ————————————————————————————————————————————————————————
// 设置
// ————————————————————————————————————————————————————————
function getByPath(obj, dotted) {
  return dotted.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
}

function applyConfig(cfg) {
  for (const input of $$('[data-cfg]')) {
    const value = getByPath(cfg, input.dataset.cfg);
    if (value === undefined) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  }
}

async function saveConfig() {
  const patch = {};
  for (const input of $$('[data-cfg]')) {
    const key = input.dataset.cfg;
    if (input.type === 'checkbox') patch[key] = input.checked;
    else if (input.type === 'number') patch[key] = Number(input.value);
    else patch[key] = input.value;
  }
  const r = await post('/api/config', { patch });
  el.cfgStatus.textContent = r.ok
    ? `已保存 ${Object.keys(r.applied || {}).length} 项${r.rejected?.length ? `（忽略 ${r.rejected.length} 项只读）` : ''}`
    : `保存失败：${r.error ?? '未知'}`;
}

// ————————————————————————————————————————————————————————
// 日志轮询
// ————————————————————————————————————————————————————————
let logPaused = false;
async function pollLogs() {
  if (logPaused) return;
  try {
    const res = await fetch('/api/logs?limit=300');
    const data = await res.json();
    const atBottom = el.logs.scrollTop + el.logs.clientHeight >= el.logs.scrollHeight - 40;
    el.logs.textContent = (data.logs || [])
      .map((l) => `${new Date(l.ts).toTimeString().slice(0, 8)} ${l.level.toUpperCase().padEnd(5)} [${l.module}] ${l.text}`)
      .join('\n');
    if (atBottom) el.logs.scrollTop = el.logs.scrollHeight;
  } catch {
    /* 服务端重启的瞬间会失败，下一轮就好 */
  }
}

// ————————————————————————————————————————————————————————
// WebSocket
// ————————————————————————————————————————————————————————
let ws = null;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=admin`);

  ws.onopen = () => {
    retry = 0;
    connected = true;
  };
  ws.onclose = () => {
    connected = false;
    el.subtitle.textContent = '与服务的连接断开，正在重连…';
    retry = Math.min(12, retry + 1);
    setTimeout(connect, Math.min(6000, 400 * retry));
  };
  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello': {
        if (msg.state) renderStats(msg.state, null);
        for (const item of msg.recent || []) onStageCmd(item);
        break;
      }
      case 'state':
        lastState = msg.data;
        renderStats(lastState, lastSource);
        break;
      case 'source':
        lastSource = msg.data;
        renderStats(lastState, lastSource);
        break;
      case 'stage-cmd':
        onStageCmd(msg.data);
        break;
      case 'live':
        for (const item of msg.data ?? []) onLiveEvent(item);
        break;
      case 'stage-status': {
        const d = msg.data ?? {};
        const hint = document.getElementById('songStatus');
        if (hint && d.hasGame === false) {
          hint.textContent = '⚠ 舞台页面是旧版，请刷新 /avatar（Ctrl+F5）';
          hint.style.color = '#ff7a8a';
        }
        break;
      }
      default:
        break;
    }
  };
}

let lastSource = null;
let lastState = null;

// ————————————————————————————————————————————————————————
// 初始化
// ————————————————————————————————————————————————————————
async function init() {
  // 标签页
  for (const tab of $$('.tab')) {
    tab.onclick = () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab.dataset.tab));
  if (tab.dataset.tab === 'stats') loadStats();
    };
  }

  // 按钮
  $('#sayBtn').onclick = async () => {
    const text = $('#sayInput').value.trim();
    if (!text) return;
    const r = await post('/api/manual', { kind: 'say', text });
    if (r.ok) $('#sayInput').value = '';
    flash($('#sayBtn'), r.ok ? '已说' : '失败');
  };
  $('#sayInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#sayBtn').click();
  });

  $('#songBtn').onclick = async () => {
    const song = $('#songInput').value.trim();
    const tier = Number($('#songTier').value) || 4;
    const mine = $('#songStatus');
    mine.textContent = '提交中…';
    const r = await post('/api/manual', { kind: 'song', song, tier, grant: true, name: '测试观众' });
    const res = r.result ?? r;
    if (res.ok) {
      mine.textContent = `已入队：${res.song}（第 ${res.position} 位${res.needRender ? '，需要渲染' : '，曲库直出'}）`;
      $('#songInput').value = '';
    } else {
      const why = {
        no_credit: '没有点歌券（先打赏 T3+）',
        daily_limit: '今天点太多了',
        rejected: '歌名没过门禁',
        not_in_library: '曲库没有，且档位不够现场渲染',
        queue_full: '队列满了',
        tier_too_low: '档位不够',
      }[res.reason] ?? (res.reason || r.error || '未知原因');
      mine.textContent = `失败：${why}`;
    }
  };

  $('#gameBtn').onclick = async () => {
    const r = await post('/api/manual', { kind: 'game' });
    $('#gameStatus').textContent = r.ok ? `开局：${r.category} · ${r.length} 个字` : `开不了：${r.reason}`;
  };
  $('#gameStopBtn').onclick = async () => {
    const r = await post('/api/manual', { kind: 'game', action: 'stop' });
    $('#gameStatus').textContent = r.ok ? '已结束本局' : '本来就没在玩';
  };

  $('#songStopBtn').onclick = async () => {
    const r = await post('/api/manual', { kind: 'stopSong' });
    $('#songStatus').textContent = r.ok ? '已停止播放' : '停止失败';
  };
  $('#songClearBtn').onclick = async () => {
    const r = await post('/api/manual', { kind: 'clearSongs' });
    $('#songStatus').textContent = r.ok ? `已清空 ${r.cleared ?? 0} 条点歌` : '清空失败';
  };

  $('#resetBtn').onclick = () => post('/api/manual', { kind: 'reset' }).then((r) => flash($('#resetBtn'), r.ok ? '已复位' : '失败'));
  $('#srcStop').onclick = () => post('/api/source', { action: 'stop' });
  $('#srcStart').onclick = () => post('/api/source', { action: 'start' });
  $('#saveCfg').onclick = saveConfig;
  $('#clearLogs').onclick = () => {
    el.logs.textContent = '';
    logPaused = true;
    setTimeout(() => (logPaused = false), 4000);
  };

  // 数据
  try {
    const [cat, state] = await Promise.all([fetch('/api/catalog').then((r) => r.json()), fetch('/api/state').then((r) => r.json())]);
    catalog = cat;
    lastState = state.state;
    lastSource = state.source;
    buildTestButtons();
    applyConfig(state.config ?? {});
    renderStats(state.state, state.source);
  } catch (err) {
    el.subtitle.textContent = `初始化失败：${err.message}`;
  }

  connect();
  pollLogs();
  setInterval(pollLogs, 3000);
}

// 直播间事件走 HTTP 轮询太浪费，这里让服务端把每条事件也推给管控台
// （Hub 在收到 /api/events 之外，还会把 live 事件广播到 admin 组）
init();

// ————————————————————————————————————————————————
// 数据页
// ————————————————————————————————————————————————
function table(rows, cols) {
  if (!rows.length) return '<p class="hint">还没有数据</p>';
  const head = cols.map((c) => `<th>${c.label}</th>`).join('');
  const body = rows.map((r) => '<tr>' + cols.map((c) => `<td>${c.value(r)}</td>`).join('') + '</tr>').join('');
  return `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function loadStats() {
  let res;
  try {
    res = await fetch('/api/stats').then((r) => r.json());
  } catch {
    return;
  }
  const s = res?.stats;
  if (!s) return;
  const t = s.today;
  const fmt = (n) => Number(n ?? 0).toLocaleString('zh-CN');

  $('#statsDate').textContent = t.date;
  $('#statsUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');

  $('#statsSummary').innerHTML = table(
    [
      { k: '礼物', v: `${fmt(t.gifts.count)} 次` },
      { k: '抖币', v: fmt(t.gifts.diamonds) },
      { k: '弹幕', v: fmt(t.interactions.comments) },
      { k: '点赞', v: fmt(t.interactions.likes) },
      { k: '进场', v: fmt(t.interactions.enters) },
      { k: '关注', v: fmt(t.interactions.follows) },
      { k: '游戏局数', v: fmt(t.games.count) },
      { k: '游戏轮数', v: fmt(t.games.rounds) },
      { k: '投票人次', v: fmt(t.games.votes) },
      { k: '参与人数', v: fmt(t.voters) },
    ],
    [
      { label: '项目', value: (r) => r.k },
      { label: '今天', value: (r) => r.v },
    ],
  );

  $('#statsGifts').innerHTML = table(s.topGifts ?? [], [
    { label: '礼物', value: (r) => r.name },
    { label: '次数', value: (r) => fmt(r.count) },
    { label: '抖币', value: (r) => fmt(r.diamonds) },
  ]);

  $('#statsUsers').innerHTML = table(s.topUsers ?? [], [
    { label: '观众', value: (r) => r.name },
    { label: '次数', value: (r) => fmt(r.count) },
    { label: '抖币', value: (r) => fmt(r.diamonds) },
  ]);

  $('#statsHistory').innerHTML = table(s.history ?? [], [
    { label: '日期', value: (r) => r.date },
    { label: '礼物', value: (r) => fmt(r.gifts) },
    { label: '抖币', value: (r) => fmt(r.diamonds) },
    { label: '弹幕', value: (r) => fmt(r.comments) },
    { label: '局数', value: (r) => fmt(r.games) },
    { label: '投票', value: (r) => fmt(r.votes) },
    { label: '参与', value: (r) => fmt(r.voters) },
  ]);
}

const statsBtn = document.getElementById('statsRefresh');
if (statsBtn) statsBtn.onclick = loadStats;
setInterval(() => {
  const pane = document.querySelector('.pane[data-pane="stats"]');
  if (pane?.classList.contains('active')) loadStats();
}, 15000);
