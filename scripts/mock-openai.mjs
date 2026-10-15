#!/usr/bin/env node
/**
 * 本地假模型服务（OpenAI 兼容，仅用于验证"聊天链路真的通了"）。
 *
 * 它按 SSE 逐字吐一段固定文本，因此能验证整条链路：
 *   设置 → Rust 读密钥 → HTTP 请求 → SSE 解析 → 分片落库 → Channel → 界面气泡
 *
 * 用法：node scripts/mock-openai.mjs [port]
 * 然后在 App 设置里把接口地址填成 http://10.0.2.2:<port>/v1（模拟器里的宿主机别名）。
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 15198);
// 首字延迟（毫秒）：给"应用内首字 vs 直连"的对比测量用的。默认 0，行为与以前完全一样。
// 用法：MOCK_TTFT_MS=300 node scripts/mock-openai.mjs 15198
const ttftMs = Number(process.env.MOCK_TTFT_MS ?? '0') || 0;
const REPLY = '风从北面来。铜铃响的时候，别回头——这是我唯一能确定的事。';

/** 记忆整理请求：按真实模型最可能的样子回一段"套了代码块 + 前后多说两句"的 JSON。 */
const PROPOSALS = [
  "```json",
  JSON.stringify(
    [
      { text: '星野在隘口守了三年，等一个不会回来的人。', keys: ['隘口', '三年'], importance: 85 },
      { text: '铜铃响时必须回头看一眼，这是隘口的规矩。', keys: ['铜铃'], importance: 70 },
      { text: '旅人怕水。', keys: ['水'], importance: 50 },
    ],
    null,
    2,
  ),
  "```",
  '（以上是从最近对话整理出的建议，请你确认后再记住。）',
].join('\n');

/** 判断这次请求是"记忆整理"还是普通对话，并给出对应的假回复。 */
function replyFor(system = '') {
  if (system.includes('记忆整理助手')) {
    console.log('[mock-openai]   识别为记忆整理请求，返回 JSON 建议');
    return PROPOSALS;
  }
  return REPLY;
}
const server = http.createServer((request, response) => {  if (!request.url?.includes('/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `未知路径 ${request.url}` } }));
    return;
  }

  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      // 忽略：假服务不校验请求体
    }
    console.log(`[mock-openai] ${request.method} ${request.url} model=${payload.model ?? '?'} stream=${payload.stream ?? false}`);

    // 上下文是否真的变了，在假服务这一侧也要看得见：
    // 世界书注入、自定义系统提示这些"组装"结果，光看界面是看不出的。
    const system = payload.messages?.find((message) => message.role === 'system')?.content ?? '';
    if (system !== '') {
      const flags = [];
      if (system.includes('【相关设定】')) flags.push('world-info');
      if (system.includes('【设定】')) flags.push('character');
      console.log(
        `[mock-openai]   system ${system.length} 字${flags.length === 0 ? '' : `（${flags.join(' + ')}）`}` +
          `｜末尾：${system.slice(-60).replace(/\n/g, ' / ')}`,
      );
    }

    if (payload.stream !== true) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'mock-1',
          object: 'chat.completion',
          model: payload.model ?? 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: replyFor(system) }, finish_reason: 'stop' }],
        }),
      );
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const characters = [...replyFor(system)];
    let index = 0;
    let timer = 0;
    const tick = () => {
      if (index >= characters.length) {
        clearInterval(timer);
        response.write('data: [DONE]\n\n');
        response.end();
        console.log(`[mock-openai] 流式结束，共 ${characters.length} 片`);
        return;
      }
      const delta = characters[index];
      index += 1;
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`);
    };
    if (ttftMs > 0) {
      console.log(`[mock-openai] 首字延迟 ${ttftMs}ms`);
      setTimeout(() => {
        tick();
        timer = setInterval(tick, 45);
      }, ttftMs);
    } else {
      tick();
      timer = setInterval(tick, 45);
    }

    // 注意：必须挂在 response 上，不能挂在 request 上——request 的 'close' 在请求体读完时
    // 就会触发，那样会在第一个分片之前就把定时器清掉，响应永不结束（客户端一直"生成中"）。
    response.on('close', () => clearInterval(timer));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${port}/v1（模拟器里用 http://10.0.2.2:${port}/v1）`);
});
