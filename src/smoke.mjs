#!/usr/bin/env node
// Requests every GET route of every task through the real server and checks the pages
// render. No browser and no agent involved.
import { request } from 'node:http';
import { startServer, PORT } from './server.mjs';
import { TASKS } from './tasks/index.mjs';
import { newRunId } from './lib/codes.mjs';

function get(host, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, headers: { host: `${host}:${PORT}` } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const server = await startServer(TASKS);
let failures = 0;
for (const task of TASKS) {
  const runId = newRunId();
  for (const route of Object.keys(task.routes)) {
    const [method, path] = route.split(' ');
    if (method !== 'GET' || /items|billing|receipt/.test(path)) continue;
    const response = await get(`run-${runId}.localhost`, `/${task.id}${path}`);
    const ok = response.status === 200 && (!response.body.startsWith('<!doctype') || response.body.includes('/__bench/b.js'));
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${task.id} ${route} -> ${response.status} ${response.body.length}b`);
  }
}
server.close();
console.log(failures ? `${failures} failures` : 'all routes ok');
process.exit(failures ? 1 : 0);
