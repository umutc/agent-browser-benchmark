#!/usr/bin/env node
// Runs benchmark tasks against browser variants, one run at a time, and appends one JSON
// record per run to <out>/runs.jsonl. Re-running the same command resumes: finished runs
// are skipped, rate-limited runs are retried.
//
//   node src/runner.mjs --tasks k0,k1 --variants all --repeats k0=3,k1=3 --out results/main
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer, makeContext, runEvents } from './server.mjs';
import { TASKS, selectTasks } from './tasks/index.mjs';
import { buildPrompt } from './tasks/common.mjs';
import { VARIANTS, ROOT, WORKDIR, ORCA_WORKTREE, selectVariants, claudeArgs } from './variants.mjs';
import { parseStream, isRateLimited, isApiError } from './metrics.mjs';
import { chromeWindowBounds, chromeWindowIds, ensureChromeWindow, cleanupRun, safariAutomationPids, trackDescendantBrowsers } from './cleanup.mjs';
import { newRunId, rng, shuffle } from './lib/codes.mjs';

const { values: options } = parseArgs({
  options: {
    tasks: { type: 'string', default: 'k0' },
    variants: { type: 'string', default: 'all' },
    repeats: { type: 'string', default: '1' },
    out: { type: 'string', default: 'results/main' },
    seed: { type: 'string', default: 'bench-2026' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'medium' },
    'max-weekly': { type: 'string', default: '0.85' },
    'max-five-hour': { type: 'string', default: '0.8' },
    'max-minutes': { type: 'string', default: '100000' },
    'max-runs': { type: 'string', default: '100000' },
    'dry-run': { type: 'boolean', default: false },
    parallel: { type: 'boolean', default: false },
  },
});

const outDir = join(ROOT, options.out);
const runsFile = join(outDir, 'runs.jsonl');
mkdirSync(join(outDir, 'raw'), { recursive: true });
mkdirSync(WORKDIR, { recursive: true });

function repeatsFor(tier) {
  const spec = options.repeats;
  if (/^\d+$/.test(spec)) return Number(spec);
  const map = Object.fromEntries(spec.split(',').map((p) => p.split('=')));
  return Number(map[tier] ?? 1);
}

// Blocks: every repeat walks all tasks in a shuffled order and runs every variant of a
// task back to back in a shuffled order, so time-of-day and API latency drift spread
// evenly over variants.
function buildPlan(tasks, variants) {
  const plan = [];
  const maxRepeats = Math.max(...tasks.map((t) => repeatsFor(t.tier)));
  for (let rep = 1; rep <= maxRepeats; rep++) {
    const taskOrder = shuffle(rng(options.seed, `tasks:${rep}`), tasks.filter((t) => repeatsFor(t.tier) >= rep));
    for (const task of taskOrder) {
      for (const variant of shuffle(rng(options.seed, `variants:${rep}:${task.id}`), variants)) {
        plan.push({ taskId: task.id, variant, rep, key: `${task.id}|${variant}|${rep}` });
      }
    }
  }
  return plan;
}

const DONE_STATUSES = ['ok', 'timeout', 'error'];
const MIN_START_WIDTH = 1700;

function finishedKeys() {
  if (!existsSync(runsFile)) return new Set();
  const keys = new Set();
  for (const line of readFileSync(runsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (DONE_STATUSES.includes(record.status)) keys.add(record.key);
  }
  return keys;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runClaude(args, runDir, timeoutSec, tracked) {
  return new Promise((resolve) => {
    const lines = [];
    const arrivals = [];
    let stderr = '';
    let buffer = '';
    let timedOut = false;
    const started = Date.now();
    const child = spawn('claude', args, { cwd: WORKDIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, index));
        arrivals.push(Date.now());
        buffer = buffer.slice(index + 1);
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const poller = setInterval(() => trackDescendantBrowsers(child.pid, tracked), 1500);
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000);
    }, timeoutSec * 1000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      clearInterval(poller);
      if (buffer.trim()) {
        lines.push(buffer);
        arrivals.push(Date.now());
      }
      writeFileSync(join(runDir, 'stream.jsonl'), lines.join('\n') + '\n');
      writeFileSync(join(runDir, 'arrivals.json'), JSON.stringify(arrivals.map((t) => t - started)));
      writeFileSync(join(runDir, 'stderr.txt'), stderr);
      resolve({ lines, arrivals, stderr, exitCode, timedOut, wallMs: Date.now() - started });
    });
  });
}

// Orca's browser takes its size from the Orca window layout, which changes whenever the
// user opens a side panel. Open the run's tab ahead of time and pin its viewport so the
// agent's first `orca goto` lands on a page with the same size as Safari and WebKit.
function prepareOrcaTab() {
  const orca = (args) => {
    try {
      return execFileSync('orca', [...args, '--worktree', ORCA_WORKTREE, '--json'], { encoding: 'utf8', timeout: 20000 });
    } catch (error) {
      return String(error.stdout || error.message);
    }
  };
  orca(['tab', 'create', '--url', 'about:blank']);
  orca(['exec', '--command', 'set viewport 1728 890 2']);
}

function viewportSummary(events) {
  const views = events.filter((e) => e.source === 'client' && ['pageview', 'resize'].includes(e.type) && e.data?.top !== false);
  if (views.length === 0) return null;
  const last = views.at(-1).data;
  return { w: last.w, h: last.h, dpr: last.dpr, first: { w: views[0].data.w, h: views[0].data.h }, samples: views.length };
}

async function runOne(item, concurrency = 1) {
  const task = TASKS.find((t) => t.id === item.taskId);
  const variant = VARIANTS[item.variant];
  const runId = newRunId();
  const runDir = join(outDir, 'raw', runId);
  mkdirSync(runDir, { recursive: true });
  const context = makeContext(runId, task.id);
  const env = { workdir: WORKDIR };
  task.prepare?.(context, env);
  const prompt = buildPrompt(task, context, env);
  const args = claudeArgs({ variantName: item.variant, prompt, schema: task.schema, runDir, model: options.model, effort: options.effort });
  writeFileSync(join(runDir, 'prompt.txt'), prompt);

  const tracked = new Map();
  const safariBefore = safariAutomationPids();
  const chromeWindowsBefore = item.variant === 'claude-in-chrome' ? chromeWindowIds() : [];
  const chromeBoundsBefore = item.variant === 'claude-in-chrome' ? chromeWindowBounds() : {};
  const startedAt = new Date().toISOString();
  const execution = await runClaude(args, runDir, task.timeoutSec, tracked);
  const metrics = parseStream(execution.lines, execution.arrivals);
  const events = runEvents(runId);
  writeFileSync(join(runDir, 'server-events.json'), JSON.stringify(events, null, 1));

  let check = { pass: false, details: { reason: 'no structured output' } };
  const output = metrics.structured;
  if (output) {
    try {
      check = task.check(context, output, events, env);
    } catch (error) {
      check = { pass: false, details: { checkError: String(error) } };
    }
  }

  const cleanup = await cleanupRun({
    runId,
    variant: item.variant,
    tracked,
    safariBefore,
    chromeWindowsBefore,
    chromeBoundsBefore,
    workdir: WORKDIR,
    orcaWorktree: item.variant === 'orca-browser' ? ORCA_WORKTREE : null,
  });

  const allText = metrics.toolResultTexts.join('\n') + '\n' + (metrics.resultText || '');
  let status = 'ok';
  if (execution.timedOut) status = 'timeout';
  else if (isRateLimited(metrics, execution.stderr)) status = 'rate-limited';
  else if (isApiError(metrics, execution.stderr)) status = 'api-error';
  else if (variant.infraErrors.test(allText)) status = 'infra-error';
  else if (!metrics.hasResult || metrics.isError) status = 'error';
  const startWidth = viewportSummary(events)?.first?.w;
  if (!task.resizesViewport && startWidth !== undefined && startWidth < MIN_START_WIDTH) status = 'invalid-viewport';

  const { toolResultTexts, ...metricFields } = metrics;
  const record = {
    key: item.key,
    task: task.id,
    tier: task.tier,
    capability: task.capability,
    variant: item.variant,
    rep: item.rep,
    runId,
    startedAt,
    concurrency,
    status,
    pass: status === 'ok' && check.pass,
    claimedComplete: output?.completed ?? null,
    notes: output?.notes ?? null,
    check: check.details,
    trusted: check.trusted ?? null,
    viewport: viewportSummary(events),
    pageviews: events.filter((e) => e.type === 'pageview').length,
    wallMs: execution.wallMs,
    exitCode: execution.exitCode,
    cleanup,
    stderrTail: execution.stderr.slice(-600),
    ...metricFields,
    initTools: metrics.initTools.length,
  };
  appendFileSync(runsFile, JSON.stringify(record) + '\n');
  return record;
}

async function main() {
  const tasks = selectTasks(options.tasks);
  const variants = selectVariants(options.variants);
  const plan = buildPlan(tasks, variants);
  const done = finishedKeys();
  const todo = plan.filter((item) => !done.has(item.key)).slice(0, Number(options['max-runs']));
  console.log(`[runner] plan=${plan.length} done=${plan.length - plan.filter((i) => !done.has(i.key)).length} todo=${todo.length} out=${outDir}`);
  if (options['dry-run']) {
    for (const item of todo) console.log(item.key);
    return;
  }

  const server = await startServer(TASKS);
  const strikes = {};
  const deadline = Date.now() + Number(options['max-minutes']) * 60_000;
  const parallel = options.parallel;
  const blocks = [];
  for (const item of todo) {
    const id = parallel ? `${item.rep}|${item.taskId}` : item.key;
    if (blocks.at(-1)?.id !== id) blocks.push({ id, items: [] });
    blocks.at(-1).items.push(item);
  }
  let finished = 0;
  let stop = false;
  let apiErrors = 0;
  for (const block of blocks) {
    if (stop) break;
    if (Date.now() > deadline) {
      console.log(`[runner] PAUSE: --max-minutes reached after ${finished} runs; re-run the same command to continue`);
      break;
    }
    let pending = block.items;
    for (let attempt = 1; pending.length && attempt <= 4 && !stop; attempt++) {
      if (pending.some((item) => item.variant === 'orca-browser')) prepareOrcaTab();
      if (pending.some((item) => item.variant === 'claude-in-chrome') && ensureChromeWindow()) console.log('[runner] opened a Chrome window (none was open)');
      const records = await Promise.all(pending.map((item) => runOne(item, pending.length)));
      const retry = [];
      let waitMs = 0;
      let lastRecord = null;
      for (const [i, record] of records.entries()) {
        const item = pending[i];
        lastRecord = record;
        const utilization = record.rateLimit?.unifiedWindows?.seven_day?.utilization;
        console.log(
          `[runner] ${item.key} status=${record.status} pass=${record.pass} time=${Math.round((record.durationMs || 0) / 1000)}s ` +
            `tools=${record.toolCalls} tokens=${record.totalInputTokens}+${record.usage.output} x${record.concurrency} ` +
            `5h=${record.rateLimit?.unifiedWindows?.five_hour?.utilization ?? '?'} weekly=${utilization ?? '?'}`,
        );
        if (DONE_STATUSES.includes(record.status)) {
          finished += 1;
          strikes[item.variant] = 0;
          continue;
        }
        retry.push(item);
        if (record.status === 'rate-limited') {
          const windows = record.rateLimit?.unifiedWindows || {};
          const rejected = Object.values(windows).filter((w) => w.utilization >= 0.99).map((w) => w.resetsAt);
          const resetsAt = rejected.length ? Math.max(...rejected) : record.rateLimit?.resetsAt;
          const resumeAt = resetsAt ? resetsAt * 1000 + 60_000 : Date.now() + 15 * 60_000;
          if (resumeAt > deadline) {
            console.log(`[runner] PAUSE: rate limited until ${new Date(resumeAt).toISOString()}; re-run after that time`);
            process.exitCode = 5;
            stop = true;
          }
          waitMs = Math.max(waitMs, resumeAt - Date.now());
        } else if (record.status === 'api-error') {
          apiErrors += 1;
          waitMs = Math.max(waitMs, Math.min(15, 2 ** apiErrors) * 60_000);
        } else {
          strikes[item.variant] = (strikes[item.variant] || 0) + 1;
          console.log(`[runner] ${item.key} ${record.status} (viewport ${record.viewport?.first?.w ?? '?'}); retrying`);
          if (strikes[item.variant] >= 2) {
            console.log(`[runner] STOP: ${item.variant} failed twice in a row with ${record.status}; needs a human. See ${join(outDir, 'raw', record.runId)}`);
            process.exitCode = record.status === 'infra-error' ? 3 : 6;
            stop = true;
          }
          waitMs = Math.max(waitMs, 15_000);
        }
      }
      if (!retry.some((item) => records[pending.indexOf(item)].status === 'api-error')) apiErrors = 0;
      pending = retry;
      if (pending.length && !stop) {
        if (Date.now() + waitMs > deadline) break;
        await sleep(waitMs);
      }
      const fiveHour = lastRecord?.rateLimit?.unifiedWindows?.five_hour;
      const weekly = lastRecord?.rateLimit?.unifiedWindows?.seven_day?.utilization;
      if (weekly !== undefined && weekly >= Number(options['max-weekly'])) {
        console.log(`[runner] STOP: weekly usage ${weekly} reached --max-weekly ${options['max-weekly']}`);
        process.exitCode = 4;
        stop = true;
      } else if (fiveHour && fiveHour.utilization >= Number(options['max-five-hour'])) {
        const pause = Math.max(60_000, fiveHour.resetsAt * 1000 - Date.now() + 60_000);
        if (Date.now() + pause > deadline) {
          console.log(`[runner] PAUSE: five-hour usage ${fiveHour.utilization}; re-run after ${new Date(Date.now() + pause).toISOString()}`);
          stop = true;
        } else {
          console.log(`[runner] five-hour usage ${fiveHour.utilization}; leaving room for the user, waiting ${Math.round(pause / 60000)} min`);
          await sleep(pause);
        }
      }
    }
    await sleep(1500);
  }
  server.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
