#!/usr/bin/env node
// Transparent stdio MCP proxy in front of `safaridriver --mcp`. Safari has no launch
// flag for window size, so the proxy sizes the automation window before the agent's
// first browser call and again after every create_tab, without the agent seeing it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [width, height] = (process.env.SAFARI_VIEWPORT || '1728x1117').split('x').map(Number);
const child = spawn('/usr/bin/safaridriver', ['--mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
const heldResponses = new Map();
let nextId = 1;
let ready = false;
const queue = [];

const log = (message) => process.stderr.write(`[safari-proxy] ${message}\n`);
const toChild = (line) => child.stdin.write(line + '\n');
const toClient = (line) => process.stdout.write(line + '\n');

function call(name, args) {
  return new Promise((resolve) => {
    const id = `bench-proxy-${nextId++}`;
    pending.set(id, resolve);
    toChild(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
  });
}

async function sizeWindow() {
  const response = await call('set_viewport_size', { width, height });
  log(`set_viewport_size ${width}x${height}: ${JSON.stringify(response.result?.content ?? response.error)}`);
}

async function setup() {
  const tab = await call('create_tab', {});
  log(`create_tab: ${JSON.stringify(tab.result?.content ?? tab.error)}`);
  await sizeWindow();
  ready = true;
  for (const line of queue.splice(0)) toChild(line);
}

createInterface({ input: child.stdout }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return toClient(line);
  }
  if (pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (heldResponses.has(message.id)) {
    heldResponses.delete(message.id);
    await sizeWindow();
  }
  toClient(line);
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return toChild(line);
  }
  if (message.method === 'notifications/initialized') {
    toChild(line);
    setup();
    return;
  }
  if (message.method === 'tools/call' && message.params?.name === 'create_tab') heldResponses.set(message.id, true);
  if (message.method === 'tools/call' && !ready) return queue.push(line);
  toChild(line);
});

process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
