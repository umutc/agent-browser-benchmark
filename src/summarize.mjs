#!/usr/bin/env node
// Aggregates <out>/runs.jsonl into <out>/summary.json and prints compact tables.
//   node src/summarize.mjs --out results/main
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from './variants.mjs';

const { values: options } = parseArgs({ options: { out: { type: 'string', default: 'results/main' } } });
const outDir = join(ROOT, options.out);

export function loadRuns(dir) {
  return readFileSync(join(dir, 'runs.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => !['rate-limited', 'infra-error'].includes(r.status));
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function quantile(values, q) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
}

// Wilson score interval for a pass rate; honest about small n.
export function wilson(passes, n, z = 1.96) {
  if (!n) return [null, null];
  const p = passes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function aggregate(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.variant}|${run.task}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const cells = [];
  for (const [key, list] of groups) {
    const [variant, task] = key.split('|');
    const passes = list.filter((r) => r.pass).length;
    cells.push({
      variant,
      task,
      tier: list[0].tier,
      capability: list[0].capability,
      n: list.length,
      passes,
      passRate: passes / list.length,
      ci: wilson(passes, list.length),
      timeouts: list.filter((r) => r.status === 'timeout').length,
      falseClaims: list.filter((r) => r.claimedComplete === true && !r.pass).length,
      medianSeconds: median(list.map((r) => r.durationMs / 1000)),
      medianToolCalls: median(list.map((r) => r.toolCalls)),
      medianInputTokens: median(list.map((r) => r.totalInputTokens)),
      medianOutputTokens: median(list.map((r) => r.usage?.output)),
      medianResultKB: median(list.map((r) => r.toolResultBytes / 1024)),
      medianImages: median(list.map((r) => r.toolResultImages)),
      medianCostUsd: median(list.map((r) => r.costUsd)),
      trustedRate: list.some((r) => r.trusted !== null) ? list.filter((r) => r.trusted === true).length / list.filter((r) => r.trusted !== null).length : null,
      meanRecall: list[0].tier === 'k3' ? list.reduce((s, r) => s + (r.check?.recall ?? 0), 0) / list.length : null,
      meanPrecision: list[0].tier === 'k3' ? list.reduce((s, r) => s + (r.check?.precision ?? 0), 0) / list.length : null,
      denials: list.reduce((s, r) => s + (r.permissionDenials || 0), 0),
      leftovers: list.reduce((s, r) => s + (r.cleanup?.killedProcesses?.length || 0) + (r.cleanup?.chromeTabsClosed || 0) + (r.cleanup?.orcaTabsClosed || 0), 0),
      viewport: list.map((r) => (r.viewport ? `${r.viewport.w}x${r.viewport.h}` : null)).filter(Boolean)[0] ?? null,
    });
  }
  return cells;
}

export function variantTotals(runs, tiers) {
  const byVariant = new Map();
  for (const run of runs.filter((r) => tiers.includes(r.tier))) {
    if (!byVariant.has(run.variant)) byVariant.set(run.variant, []);
    byVariant.get(run.variant).push(run);
  }
  return [...byVariant].map(([variant, list]) => {
    const passes = list.filter((r) => r.pass).length;
    return {
      variant,
      n: list.length,
      passes,
      passRate: passes / list.length,
      ci: wilson(passes, list.length),
      medianSeconds: median(list.map((r) => r.durationMs / 1000)),
      p75Seconds: quantile(list.map((r) => r.durationMs / 1000), 0.75),
      medianToolCalls: median(list.map((r) => r.toolCalls)),
      medianInputTokens: median(list.map((r) => r.totalInputTokens)),
      medianCostUsd: median(list.map((r) => r.costUsd)),
      totalCostUsd: list.reduce((s, r) => s + (r.costUsd || 0), 0),
      timeouts: list.filter((r) => r.status === 'timeout').length,
      falseClaims: list.filter((r) => r.claimedComplete === true && !r.pass).length,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runs = loadRuns(outDir);
  const cells = aggregate(runs);
  const tiers = [...new Set(runs.map((r) => r.tier))].sort();
  const totals = Object.fromEntries(tiers.map((t) => [t, variantTotals(runs, [t])]));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), runs: runs.length, cells, totals }, null, 1));

  const pad = (s, n) => String(s ?? '-').padEnd(n).slice(0, n);
  const fmt = (x, d = 0) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));
  for (const tier of tiers) {
    console.log(`\n== ${tier}`);
    console.log(pad('variant', 17) + pad('pass', 8) + pad('med s', 7) + pad('tools', 6) + pad('in tok', 8) + pad('$', 6) + pad('t/o', 4) + 'false-claim');
    for (const t of totals[tier]) {
      console.log(
        pad(t.variant, 17) + pad(`${t.passes}/${t.n}`, 8) + pad(fmt(t.medianSeconds), 7) + pad(fmt(t.medianToolCalls), 6) +
          pad(fmt(t.medianInputTokens / 1000, 0) + 'k', 8) + pad(fmt(t.medianCostUsd, 2), 6) + pad(t.timeouts, 4) + t.falseClaims,
      );
    }
  }
  console.log('\n== per task (pass count)');
  const variants = [...new Set(runs.map((r) => r.variant))].sort();
  console.log(pad('task', 16) + variants.map((v) => pad(v, 17)).join(''));
  for (const task of [...new Set(runs.map((r) => r.task))].sort()) {
    console.log(
      pad(task, 16) +
        variants
          .map((v) => {
            const cell = cells.find((c) => c.variant === v && c.task === task);
            return pad(cell ? `${cell.passes}/${cell.n} ${fmt(cell.medianSeconds)}s` : '-', 17);
          })
          .join(''),
    );
  }
}
