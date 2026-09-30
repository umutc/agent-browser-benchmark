#!/usr/bin/env node
// Health check for a running benchmark: prints anomalies in runs added since the last
// check, plus the live state of browsers on this machine.
//   node src/watch.mjs --out results/main
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from './variants.mjs';
import { chromeWindowBounds, processTable } from './cleanup.mjs';

const { values: options } = parseArgs({ options: { out: { type: 'string', default: 'results/main' } } });
const outDir = join(ROOT, options.out);
const cursorFile = join(outDir, '.watch-cursor');
const EXPECTED_START = {
  'claude-in-chrome': [1728, 873],
  'pw-chrome': [1728, 907],
  'pw-webkit': [1728, 890],
  'safari-mcp': [1728, 890],
  'orca-browser': [1728, 890],
};
const RESIZING_TASKS = new Set(['k1-responsive', 'k3-responsive']);

const lines = readFileSync(join(outDir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean);
const from = existsSync(cursorFile) ? Number(readFileSync(cursorFile, 'utf8')) : 0;
const fresh = lines.slice(from).map((l) => JSON.parse(l));
writeFileSync(cursorFile, String(lines.length));

const issues = [];
for (const r of fresh) {
  const tag = `${r.key} (${r.runId})`;
  if (r.status !== 'ok') issues.push(`${tag}: status ${r.status}`);
  else if (!r.pass) issues.push(`${tag}: failed check ${JSON.stringify(r.check).slice(0, 160)}`);
  const first = r.viewport?.first;
  const expected = EXPECTED_START[r.variant];
  if (first && expected && !RESIZING_TASKS.has(r.task) && (first.w !== expected[0] || Math.abs(first.h - expected[1]) > 40)) {
    issues.push(`${tag}: started at ${first.w}x${first.h}, expected ${expected.join('x')}`);
  }
  if (!r.viewport && r.tier !== 'k0' && r.status === 'ok') issues.push(`${tag}: no page view recorded`);
  const c = r.cleanup || {};
  if (c.killedProcesses?.length) issues.push(`${tag}: cleanup killed ${c.killedProcesses.join(', ')}`);
  if (c.chromeWindowsResized) issues.push(`${tag}: restored ${c.chromeWindowsResized} Chrome window(s)`);
  if (r.permissionDenials && r.variant !== 'claude-in-chrome') issues.push(`${tag}: ${r.permissionDenials} denied command(s)`);
}

const safari = processTable().filter((p) => /Safari\.app\/Contents\/MacOS\/Safari .*--automation/.test(p.command)).length;
const bounds = chromeWindowBounds();
const done = lines.map((l) => JSON.parse(l)).filter((r) => ['ok', 'timeout', 'error'].includes(r.status)).length;
const latestDir = readdirSync(join(outDir, 'raw')).map((d) => ({ d, t: statSync(join(outDir, 'raw', d)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
const runner = processTable().find((p) => p.command.includes('node src/runner.mjs'));
const current = processTable().filter((p) => p.command.startsWith('claude -p You are operating')).length;

console.log(`progress: ${done}/670 valid runs · ${fresh.length} new since last check · runner ${runner ? 'running' : 'NOT running'}`);
if (current && latestDir) console.log(`active runs: ${current} · newest ${latestDir.d} started ${Math.round((Date.now() - latestDir.t) / 1000)} s ago`);
console.log(`live: Safari --automation processes ${safari} (3 existed before the benchmark) · Chrome windows ${JSON.stringify(bounds)}`);
const chromeOff = Object.values(bounds).some((b) => b[2] - b[0] < 1700);
if (chromeOff) issues.push('LIVE: a Chrome window is narrower than 1700 px');
console.log(issues.length ? `issues (${issues.length}):\n  ${issues.join('\n  ')}` : 'issues: none');
