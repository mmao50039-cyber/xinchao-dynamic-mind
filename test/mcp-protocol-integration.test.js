import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { handleMcpMessage } from '../src/mcp-protocol.js';
import { SYSTEM_VERSION } from '../src/version.js';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(projectDir, 'src', 'server.js');
const request = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('MCP handshake reports the shared runtime version', async () => {
  const result = await handleMcpMessage(request('initialize', {
    protocolVersion: '2025-06-18',
  }), {});
  assert.equal(result.status, 200);
  assert.equal(result.body.result.serverInfo.version, SYSTEM_VERSION);
});

test('tools/list keeps Xinchao, board and curated OB tools together', async () => {
  const result = await handleMcpMessage(request('tools/list'), {
    boardEnabled: true,
    listObTools: async () => [
      { name: 'breath', description: 'memory', inputSchema: { type: 'object' } },
      { name: 'purge', description: 'must stay hidden', inputSchema: { type: 'object' } },
    ],
  });
  const names = result.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('xinchao_context'));
  assert.ok(names.includes('xinchao_box'));
  assert.equal(names.includes('xinchao_pending_create'), false);
  assert.equal(names.includes('xinchao_pending_consumed'), false);
  assert.ok(names.includes('xinchao_personality_reflect'));
  assert.equal(names.includes('xinchao_pending_hold'), false);
  assert.equal(names.includes('xinchao_pending_drop'), false);
  assert.ok(names.includes('board_post'));
  assert.ok(names.includes('board_read'));
  assert.ok(names.includes('breath'));
  assert.equal(names.includes('purge'), false);
});

test('AI can submit one complete monthly personality reflection through MCP', async () => {
  let received;
  const dimensions = [
    'joy', 'sorrow', 'anger', 'fear', 'disgust', 'surprise', 'love',
    'shame', 'trust', 'desire', 'calm', 'cognition', 'conflict', 'expression',
  ].map((key) => ({ key, score: 70, reason: `AI 回顾 ${key}` }));
  const result = await handleMcpMessage(request('tools/call', {
    name: 'xinchao_personality_reflect',
    arguments: { month: '2026-08', dimensions },
  }), {
    personalityReflect: async (input) => {
      received = input;
      return { month: input.month, duplicate: false };
    },
  });
  assert.equal(result.body.result.isError, false);
  assert.equal(received.month, '2026-08');
  assert.equal(received.dimensions.length, 14);
});

test('OB failure does not remove Xinchao or board tools', async () => {
  const result = await handleMcpMessage(request('tools/list'), {
    boardEnabled: true,
    listObTools: async () => { throw new Error('offline'); },
  });
  const names = result.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('xinchao_event'));
  assert.ok(names.includes('board_post'));
  assert.ok(names.includes('board_read'));
});

test('hidden tools disappear from tools/list', async () => {
  const result = await handleMcpMessage(request('tools/list'), { toolsHide: new Set(['xinchao_pending_create']) });
  const names = result.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('xinchao_box'));
  assert.ok(!names.includes('xinchao_pending_create'));
});

test('xinchao_* tool replies carry a trailing now-line; xinchao_context does not', async () => {
  const handlers = {
    nowLine: async () => '此刻：想她（涌）；情绪 安心',
    handoffNote: async () => ({ revision: 3, duplicate: false }),
    context: async () => ({ delivered: true, additionalContext: 'ctx', sections: [] }),
  };
  const note = await handleMcpMessage(request('tools/call', { name: 'xinchao_handoff_note', arguments: { event_id: 'evt-000001', note: 'x', session_id: 's' } }), handlers);
  assert.match(note.body.result.content[0].text, /此刻：想她（涌）/);
  const ctx = await handleMcpMessage(request('tools/call', { name: 'xinchao_context', arguments: { session_id: 's' } }), handlers);
  assert.doesNotMatch(ctx.body.result.content[0].text, /此刻：/);
});

test('all notifications/* (including roots/list_changed) return 202 with empty body', async () => {
  for (const method of [
    'notifications/initialized',
    'notifications/cancelled',
    'notifications/roots/list_changed',
    'notifications/progress',
  ]) {
    const result = await handleMcpMessage({ jsonrpc: '2.0', method }, {});
    assert.equal(result.status, 202, `${method} should return 202`);
    assert.equal(result.body, null, `${method} should have null body`);
  }
});

test('unknown request methods return HTTP 200 with JSON-RPC -32601 instead of HTTP 404', async () => {
  for (const [id, method] of [[2, 'resources/list'], [3, 'prompts/list'], ['req-9', 'custom/unknown']]) {
    const result = await handleMcpMessage(request(method, {}, id), {});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' },
    });
  }
});

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`心潮测试服务提前退出：${output.stdout}\n${output.stderr}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Waiting for loopback listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待心潮测试服务启动超时：${output.stdout}\n${output.stderr}`);
}

test('HTTP /mcp serves SSE heartbeats on GET, 202 on roots/list_changed, 200 -32601 on unknown methods, and keeps 401 auth', async (t) => {
  const prevHeartbeatEnv = process.env.MCP_HEARTBEAT_MS;
  delete process.env.MCP_HEARTBEAT_MS;
  try {
    assert.equal(loadConfig().mcp.heartbeatMs, 20000);
  } finally {
    if (prevHeartbeatEnv !== undefined) process.env.MCP_HEARTBEAT_MS = prevHeartbeatEnv;
  }

  const directory = await mkdtemp('/tmp/xinchao-mcp-http-');
  const port = await freePort();
  const token = 'mcp-http-test-service-token-0123456789abcdef';
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = { stdout: '', stderr: '' };

  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: directory,
      TMPDIR: '/tmp',
      PORT: String(port),
      SERVICE_TOKEN: token,
      STATE_PATH: join(directory, 'state.json'),
      PERSONALITY_PATH: join(directory, 'personality.json'),
      TRANSITION_JOURNAL_PATH: join(directory, 'transitions.jsonl'),
      OAUTH_STATE_PATH: join(directory, 'oauth.json'),
      BRIDGE_STATE_PATH: join(directory, 'bridge-queue.json'),
      BOX_STATE_PATH: join(directory, 'black-box.json'),
      CABIN_STATE_PATH: join(directory, 'cabin.json'),
      OMBRE_HEARTBEAT_FILE: join(directory, 'heartbeat.json'),
      DREAM_PUSH_PROMPT_PATH: join(projectDir, 'configs', 'dream_push_prompt.md'),
      SETTLE_INTERVAL_MINUTES: '1440',
      SHADOW_MODE: 'true',
      MODEL_ENABLED: 'false',
      OMBRE_READ_ENABLED: 'false',
      OMBRE_WRITE_ENABLED: 'false',
      CONTEXT_OMBRE_ENABLED: 'false',
      BARK_ENABLED: 'false',
      DAYTIME_EMERGENCE_ENABLED: 'false',
      DASHBOARD_ENABLED: 'false',
      BRIDGE_ENABLED: 'false',
      OAUTH_ENABLED: 'false',
      XINCHAO_BOARD_TOKEN: '',
      MCP_ENABLED: 'true',
      MCP_HEARTBEAT_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });

  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(() => {
          if (child.exitCode == null) child.kill('SIGKILL');
          resolve();
        }, 1500)),
      ]);
    }
    await rm(directory, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child, output);

  // 1. 鉴权失败照旧：无 token 或错误 token 访问 GET / POST / DELETE /mcp 均回 401
  for (const method of ['GET', 'POST', 'DELETE']) {
    const noAuth = await fetch(`${baseUrl}/mcp`, { method });
    assert.equal(noAuth.status, 401, `${method} /mcp without token should return 401`);
    assert.deepEqual(await noAuth.json(), { error: 'unauthorized' });

    const badAuth = await fetch(`${baseUrl}/mcp`, {
      method,
      headers: { authorization: 'Bearer wrong-token-value' },
    });
    assert.equal(badAuth.status, 401, `${method} /mcp with wrong token should return 401`);
  }

  // 2. initialize 握手 + 验证 Node keepAliveTimeout=65000 (Keep-Alive: timeout=65)
  const initRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request('initialize', { protocolVersion: '2025-06-18' }, 1)),
  });
  assert.equal(initRes.status, 200);
  assert.match(initRes.headers.get('keep-alive') ?? '', /timeout=65\b/);
  const sessionId = initRes.headers.get('mcp-session-id');
  assert.ok(sessionId && sessionId.startsWith('mcp-'));
  await initRes.json();

  // 3. notifications/roots/list_changed 回 202 无正文，且保留原 sessionId
  const notifyRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }),
  });
  assert.equal(notifyRes.status, 202);
  assert.equal(notifyRes.headers.get('mcp-session-id'), sessionId);
  assert.equal(await notifyRes.text(), '');

  // 4. 未知请求方法回 HTTP 200 + JSON-RPC -32601（绝不回 404 误杀会话）
  const unknownRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify(request('resources/list', {}, 42)),
  });
  assert.equal(unknownRes.status, 200);
  assert.equal(unknownRes.headers.get('mcp-session-id'), sessionId);
  assert.deepEqual(await unknownRes.json(), {
    jsonrpc: '2.0',
    id: 42,
    error: { code: -32601, message: 'Method not found' },
  });

  // 5. GET /mcp 提供 SSE 流并持续收到 : ping\n\n 心跳，断开后清理定时器
  const sse = await new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        const pings = raw.match(/^: ping\n\n/gm) ?? [];
        if (pings.length >= 2) {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, raw, pingCount: pings.length });
        }
      });
      res.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
    req.end();
  });

  assert.equal(sse.status, 200);
  assert.match(String(sse.headers['content-type'] ?? ''), /^text\/event-stream\b/);
  assert.equal(sse.headers['cache-control'], 'no-store, no-transform');
  assert.equal(sse.headers['x-accel-buffering'], 'no');
  assert.equal(sse.headers['mcp-session-id'], sessionId);
  assert.match(sse.raw, /^: connected\n\n/);
  assert.ok(sse.pingCount >= 2);

  // 等待超过一个心跳周期，确认断连后定时器已清理、服务端无异常输出且继续健康响应
  await new Promise((resolve) => setTimeout(resolve, 180));
  const methodNotAllowed = await fetch(`${baseUrl}/mcp`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(methodNotAllowed.headers.get('allow'), 'GET, POST, DELETE');
  assert.equal(output.stderr, '');
});
