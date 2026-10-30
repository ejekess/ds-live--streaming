/**
 * 本地假模型：一个最小的 OpenAI 兼容服务，用来验证「弹幕 → 大模型 → 上屏」这条链路。
 *
 * 为什么要它：
 *   真接大模型要 Key、要花钱、还会把观众弹幕发给第三方。开发时只想确认
 *   「请求发出去了吗、提示词长什么样、返回的东西能不能过校验」，
 *   这些用一个假服务就够了，而且能把每次请求原样记下来给你看。
 *
 * 用法：
 *   node tools/mock-llm.mjs            # 监听 8899
 *   node tools/mock-llm.mjs --port=9000
 *
 * 然后把 config 指向它：
 *   brain.kind = "llm"
 *   brain.llm.enabled = true
 *   brain.llm.endpoint = "http://127.0.0.1:8899/chat/completions"
 *   brain.llm.apiKeyEnv = "MOCK_LLM_KEY"     # 随便给个非空值即可
 *
 * 每次请求都会打到 stdout，同时落一份到 data/runtime/mock-llm.jsonl。
 */
import http from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg?.split('=')[1]) || 8899;
const LOG = path.resolve('data/runtime/mock-llm.jsonl');

/** 假回复：从观众那句话里抠点东西出来，让它看起来像"真的在回你"。 */
function fakeReply(messages) {
  const userMsg = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  // 取**最后一个**数据块：说明文字里万一还出现定界符，也不会取错
  const blocks = [...userMsg.matchAll(/<观众发言>\s*([\s\S]*?)\s*<\/观众发言>/g)];
  const said = (blocks.at(-1)?.[1] ?? '').replace(/\s+/g, ' ').slice(0, 18);

  const pool = [
    `（假模型）你刚说的「${said}」，我听到啦`,
    `（假模型）关于「${said}」，我觉得可以再聊聊`,
    `（假模型）诶，「${said}」是什么意思呀`,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

await mkdir(path.dirname(LOG), { recursive: true });

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: 'mock-llm' }));
    return;
  }

  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);

  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400);
    res.end('bad json');
    return;
  }

  const messages = body.messages ?? [];
  const reply = fakeReply(messages);

  const record = {
    at: new Date().toISOString(),
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    messages,
    reply,
  };
  await appendFile(LOG, JSON.stringify(record) + '\n', 'utf8');

  // 终端里打一份，方便对照
  const sys = messages.find((m) => m.role === 'system')?.content ?? '';
  const usr = messages.find((m) => m.role === 'user')?.content ?? '';
  console.log(`\n──── 收到第 ${record.at} 的请求（model=${body.model}, max_tokens=${body.max_tokens}）`);
  console.log(`[system 前 160 字] ${sys.slice(0, 160).replace(/\n/g, ' ⏎ ')}`);
  console.log(`[user]\n${usr}`);
  console.log(`[reply] ${reply}`);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'mock-llm',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
    }),
  );
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] 假模型已启动：http://127.0.0.1:${PORT}/chat/completions`);
  console.log(`[mock-llm] 请求记录：${LOG}`);
});
