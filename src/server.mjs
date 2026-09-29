import { createServer } from 'node:http';
import { code, digits, rng } from './lib/codes.mjs';
import { BEACON_JS } from './lib/html.mjs';

export const PORT = Number(process.env.BENCH_PORT || 8765);

const runs = new Map();

function runStore(runId) {
  if (!runs.has(runId)) runs.set(runId, { events: [], state: {} });
  return runs.get(runId);
}

export function makeContext(runId, taskId, extra = {}) {
  const store = runStore(runId);
  const origin = `http://run-${runId}.localhost:${PORT}`;
  const xorigin = `http://x-${runId}.localhost:${PORT}`;
  store.state[taskId] ??= {};
  return {
    runId,
    taskId,
    origin,
    xorigin,
    base: `${origin}/${taskId}`,
    url: (path = '/') => `${origin}/${taskId}${path}`,
    xurl: (path = '/') => `${xorigin}/${taskId}${path}`,
    code: (key, length) => code(runId, `${taskId}:${key}`, length),
    digits: (key, length) => digits(runId, `${taskId}:${key}`, length),
    rng: (key) => rng(runId, `${taskId}:${key}`),
    state: store.state[taskId],
    log: (type, data = {}) => store.events.push({ ts: Date.now(), source: 'server', type, data }),
    events: () => store.events,
    ...extra,
  };
}

export function runEvents(runId) {
  return runs.get(runId)?.events ?? [];
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response, result) {
  if (typeof result === 'string') result = { body: result };
  const headers = { 'cache-control': 'no-store', ...(result.headers || {}) };
  let body = result.body ?? '';
  if (result.json !== undefined) {
    body = JSON.stringify(result.json);
    headers['content-type'] ??= 'application/json';
  }
  headers['content-type'] ??= 'text/html; charset=utf-8';
  if (result.redirect) {
    headers.location = result.redirect;
    result.status ??= 303;
  }
  response.writeHead(result.status || 200, headers);
  response.end(body);
}

export function startServer(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const server = createServer(async (request, response) => {
    try {
      const host = (request.headers.host || '').toLowerCase();
      const url = new URL(request.url, `http://${host || 'localhost'}`);
      const hostMatch = host.match(/^(?:run|x)-([a-f0-9]{10})\.localhost(?::\d+)?$/);
      const runId = hostMatch?.[1];

      if (url.pathname === '/__bench/b.js') {
        return send(response, { body: BEACON_JS, headers: { 'content-type': 'text/javascript' } });
      }
      if (url.pathname === '/__bench/health') return send(response, { json: { ok: true } });
      if (!runId) return send(response, { status: 404, body: 'unknown host' });

      const body = await readBody(request);
      if (url.pathname === '/__bench/log' && request.method === 'POST') {
        let payload = {};
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {}
        runStore(runId).events.push({
          ts: Date.now(),
          source: 'client',
          type: String(payload.type || 'unknown'),
          data: payload.data ?? {},
          url: payload.url,
          host,
        });
        return send(response, { status: 204 });
      }

      const [, taskId, ...rest] = url.pathname.split('/');
      const task = byId.get(taskId);
      if (!task) return send(response, { status: 404, body: 'unknown task' });
      const path = '/' + rest.join('/');
      const handler = task.routes[`${request.method} ${path}`];
      if (!handler) return send(response, { status: 404, body: 'not found' });

      const context = makeContext(runId, taskId, { host, isCrossOrigin: host.startsWith('x-') });
      const req = {
        method: request.method,
        path,
        query: url.searchParams,
        headers: request.headers,
        cookies: parseCookies(request.headers.cookie),
        body,
        text: () => body.toString('utf8'),
        json: () => {
          try {
            return JSON.parse(body.toString('utf8'));
          } catch {
            return {};
          }
        },
        form: () => Object.fromEntries(new URLSearchParams(body.toString('utf8'))),
      };
      const result = await handler(context, req);
      return send(response, result ?? { status: 204 });
    } catch (error) {
      console.error('[server]', error);
      send(response, { status: 500, body: 'fixture server error' });
    }
  });
  return new Promise((resolve) => server.listen(PORT, '::', () => resolve(server)));
}
