#!/usr/bin/env node
// Runs benchmark tasks against browser variants, one run at a time, and appends one JSON
// record per run to <out>/runs.jsonl. Re-running the same command resumes: finished runs
// are skipped, rate-limited runs are retried.
//
//   node src/runner.mjs --tasks k0,k1 --variants all --repeats k0=3,k1=3 --out results/main
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer, makeContext, runEvents } from './server.mjs';
import { TASKS, selectTasks } from './tasks/index.mjs';
import { buildPrompt } from './tasks/common.mjs';
import { VARIANTS, ROOT, WORKDIR, ORCA_WORKTREE, selectVariants, claudeArgs } from './variants.mjs';
import { parseStream, isRateLimited } from './metrics.mjs';
import { browserProcesses, chromeWindowIds, cleanupRun } from './cleanup.mjs';
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
    'max-runs': { type: 'string', default: '100000' },
    'dry-run': { type: 'boolean', default: false },
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

function finishedKeys() {
  if (!existsSync(runsFile)) return new Set();
  const keys = new Set();
  for (const line of readFileSync(runsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (!['rate-limited', 'infra-error'].includes(record.status)) keys.add(record.key);
  }
  return keys;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runClaude(args, runDir, timeoutSec) {
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

function viewportSummary(events) {
  const views = events.filter((e) => e.source === 'client' && ['pageview', 'resize'].includes(e.type) && e.data?.top !== false);
  if (views.length === 0) return null;
  const last = views.at(-1).data;
  return { w: last.w, h: last.h, dpr: last.dpr, first: { w: views[0].data.w, h: views[0].data.h }, samples: views.length };
}

async function runOne(item) {
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

  const processesBefore = browserProcesses();
  const chromeWindowsBefore = chromeWindowIds();
  const startedAt = new Date().toISOString();
  const execution = await runClaude(args, runDir, task.timeoutSec);
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
    processesBefore,
    chromeWindowsBefore,
    workdir: WORKDIR,
    orcaWorktree: item.variant === 'orca-browser' ? ORCA_WORKTREE : null,
  });

  const allText = metrics.toolResultTexts.join('\n') + '\n' + (metrics.resultText || '');
  let status = 'ok';
  if (execution.timedOut) status = 'timeout';
  else if (isRateLimited(metrics, execution.stderr)) status = 'rate-limited';
  else if (variant.infraErrors.test(allText)) status = 'infra-error';
  else if (!metrics.hasResult || metrics.isError) status = 'error';

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
  const infraStrikes = {};
  let index = 0;
  while (index < todo.length) {
    const item = todo[index];
    const record = await runOne(item);
    const utilization = record.rateLimit?.unifiedWindows?.seven_day?.utilization;
    console.log(
      `[runner] ${index + 1}/${todo.length} ${item.key} status=${record.status} pass=${record.pass} ` +
        `time=${Math.round((record.durationMs || 0) / 1000)}s tools=${record.toolCalls} ` +
        `tokens=${record.totalInputTokens}+${record.usage.output} weekly=${utilization ?? '?'}`,
    );

    if (record.status === 'rate-limited') {
      const resetsAt = record.rateLimit?.resetsAt;
      const waitMs = resetsAt ? Math.max(60_000, resetsAt * 1000 - Date.now() + 60_000) : 10 * 60_000;
      console.log(`[runner] rate limited; waiting ${Math.round(waitMs / 60000)} min`);
      await sleep(waitMs);
      continue;
    }
    if (record.status === 'infra-error') {
      infraStrikes[item.variant] = (infraStrikes[item.variant] || 0) + 1;
      if (infraStrikes[item.variant] >= 2) {
        console.log(`[runner] STOP: ${item.variant} infrastructure failed twice; needs a human. See ${join(outDir, 'raw', record.runId)}`);
        process.exitCode = 3;
        break;
      }
      await sleep(30_000);
      continue;
    }
    infraStrikes[item.variant] = 0;
    if (utilization !== undefined && utilization >= Number(options['max-weekly'])) {
      console.log(`[runner] STOP: weekly usage ${utilization} reached --max-weekly ${options['max-weekly']}`);
      process.exitCode = 4;
      break;
    }
    index += 1;
    await sleep(1500);
  }
  server.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
