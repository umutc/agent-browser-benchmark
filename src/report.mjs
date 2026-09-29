#!/usr/bin/env node
// Builds a self-contained HTML report from <out>/runs.jsonl.
//   node src/report.mjs --out results/main --html results/main/report.html
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, VARIANTS } from './variants.mjs';
import { TASKS } from './tasks/index.mjs';
import { loadRuns, aggregate, variantTotals, median, quantile, wilson } from './summarize.mjs';

const { values: options } = parseArgs({
  options: { out: { type: 'string', default: 'results/main' }, html: { type: 'string' }, meta: { type: 'string' } },
});
const outDir = join(ROOT, options.out);
const runs = loadRuns(outDir);
const cells = aggregate(runs);
const meta = options.meta ? JSON.parse(readFileSync(join(ROOT, options.meta), 'utf8')) : {};

const ORDER = ['claude-in-chrome', 'pw-chrome', 'orca-browser', 'safari-mcp', 'pw-webkit'];
const LABEL = {
  'claude-in-chrome': 'Claude in Chrome',
  'pw-chrome': 'Playwright · Chrome',
  'orca-browser': 'Orca browser',
  'safari-mcp': 'Safari MCP',
  'pw-webkit': 'Playwright · WebKit',
};
const SLOT = { 'claude-in-chrome': 1, 'pw-chrome': 2, 'orca-browser': 3, 'safari-mcp': 4, 'pw-webkit': 5 };
const variants = ORDER.filter((v) => runs.some((r) => r.variant === v));
const taskById = Object.fromEntries(TASKS.map((t) => [t.id, t]));
const tiersPresent = [...new Set(runs.map((r) => r.tier))];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const num = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const kTok = (x) => (x === null || x === undefined ? '–' : `${num(x / 1000, x >= 100000 ? 0 : 1)}k`);
const swatch = (v) => `<span class="sw s${SLOT[v]}" aria-hidden="true"></span>`;
const vname = (v) => `${swatch(v)}${esc(LABEL[v])}`;

const runsOf = (filter) => runs.filter(filter);
const tierRuns = (tier, v) => runs.filter((r) => r.tier === tier && r.variant === v);

// ---------- scorecard ----------
function capabilityCount(v) {
  const k1 = cells.filter((c) => c.tier === 'k1' && c.variant === v);
  return { solid: k1.filter((c) => c.passRate >= 2 / 3).length, total: k1.length };
}

function scoreRow(v) {
  const k2 = tierRuns('k2', v);
  const k3 = tierRuns('k3', v);
  const k1 = tierRuns('k1', v);
  const all = runs.filter((r) => r.variant === v && r.tier !== 'k0');
  const base = tierRuns('k0', v);
  const cap = capabilityCount(v);
  const k2pass = k2.filter((r) => r.pass).length;
  return {
    v,
    cap,
    k1rate: k1.length ? k1.filter((r) => r.pass).length / k1.length : null,
    k2rate: k2.length ? k2pass / k2.length : null,
    k2ci: wilson(k2pass, k2.length),
    k3recall: k3.length ? k3.reduce((s, r) => s + (r.check?.recall ?? 0), 0) / k3.length : null,
    k3precision: k3.length ? k3.reduce((s, r) => s + (r.check?.precision ?? 0), 0) / k3.length : null,
    medSec: median(all.map((r) => r.durationMs / 1000)),
    medTok: median(all.map((r) => r.totalInputTokens)),
    baseTok: median(base.map((r) => r.totalInputTokens)),
    medCost: median(all.map((r) => r.costUsd)),
    timeouts: all.filter((r) => r.status === 'timeout').length,
    falseClaims: all.filter((r) => r.claimedComplete === true && !r.pass).length,
    n: all.length,
  };
}
const score = variants.map(scoreRow);

// ---------- SVG helpers ----------
function niceMax(value) {
  const exp = 10 ** Math.floor(Math.log10(value || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= value) return m * exp;
  return 10 * exp;
}

// Horizontal dot-and-range: median with interquartile range per variant.
function rangeChart({ id, title, unit, rows, max }) {
  if (!rows.some((r) => r.mid !== null && r.mid !== undefined)) return '';
  const width = 640;
  const left = 150;
  const right = 24;
  const rowH = 34;
  const top = 8;
  const height = top + rows.length * rowH + 30;
  const scaleMax = niceMax(max ?? Math.max(...rows.map((r) => r.hi ?? r.mid ?? 0)) * 1.05);
  const x = (value) => left + ((width - left - right) * value) / scaleMax;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * scaleMax);
  const body = rows
    .map((r, i) => {
      const y = top + i * rowH + rowH / 2;
      if (r.mid === null || r.mid === undefined) return `<text x="${left - 10}" y="${y + 4}" class="lab" text-anchor="end">${esc(LABEL[r.v])}</text><text x="${left + 4}" y="${y + 4}" class="val">no data</text>`;
      return `<g class="mark" tabindex="0"><title>${esc(LABEL[r.v])}: median ${num(r.mid, 1)} ${unit} (IQR ${num(r.lo, 1)}–${num(r.hi, 1)})</title>
        <text x="${left - 10}" y="${y + 4}" class="lab" text-anchor="end">${esc(LABEL[r.v])}</text>
        <line x1="${x(r.lo)}" x2="${x(r.hi)}" y1="${y}" y2="${y}" class="rng c${SLOT[r.v]}"/>
        <circle cx="${x(r.mid)}" cy="${y}" r="6" class="dot f${SLOT[r.v]}"/>
        <text x="${x(r.hi) + 10}" y="${y + 4}" class="val">${num(r.mid, r.mid < 10 ? 1 : 0)}</text></g>`;
    })
    .join('');
  const axis = ticks
    .map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${height - 24}" class="grid"/><text x="${x(t)}" y="${height - 8}" class="tick" text-anchor="middle">${num(t, t < 10 && t % 1 ? 1 : 0)}</text>`)
    .join('');
  return `<figure class="chart" id="${id}"><figcaption>${esc(title)}</figcaption>
    <div class="scroll"><svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}">${axis}${body}</svg></div>
    <p class="axis-note">${esc(unit)} · dot = median, line = middle 50% of runs</p></figure>`;
}

// Horizontal bars with a CI whisker for rates.
function rateChart({ id, title, rows }) {
  if (!rows.some((r) => r.rate !== null)) return '';
  const width = 640;
  const left = 150;
  const right = 60;
  const rowH = 34;
  const top = 8;
  const height = top + rows.length * rowH + 30;
  const x = (value) => left + (width - left - right) * value;
  const axis = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${height - 24}" class="grid"/><text x="${x(t)}" y="${height - 8}" class="tick" text-anchor="middle">${t * 100}%</text>`)
    .join('');
  const body = rows
    .map((r, i) => {
      const y = top + i * rowH;
      const barH = 16;
      const cy = y + rowH / 2;
      if (r.rate === null) return '';
      const w = Math.max(0, x(r.rate) - left);
      return `<g class="mark" tabindex="0"><title>${esc(LABEL[r.v])}: ${pct(r.rate)} (95% CI ${pct(r.ci[0])}–${pct(r.ci[1])}, n=${r.n})</title>
        <text x="${left - 10}" y="${cy + 4}" class="lab" text-anchor="end">${esc(LABEL[r.v])}</text>
        <path d="M${left},${cy - barH / 2} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h-${Math.max(0, w - 4)} z" class="f${SLOT[r.v]}"/>
        <line x1="${x(r.ci[0])}" x2="${x(r.ci[1])}" y1="${cy}" y2="${cy}" class="ci"/>
        <line x1="${x(r.ci[0])}" x2="${x(r.ci[0])}" y1="${cy - 5}" y2="${cy + 5}" class="ci"/><line x1="${x(r.ci[1])}" x2="${x(r.ci[1])}" y1="${cy - 5}" y2="${cy + 5}" class="ci"/>
        <text x="${width - right + 8}" y="${cy + 4}" class="val">${pct(r.rate)}</text></g>`;
    })
    .join('');
  return `<figure class="chart" id="${id}"><figcaption>${esc(title)}</figcaption>
    <div class="scroll"><svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}">${axis}${body}</svg></div>
    <p class="axis-note">share of runs that passed · whisker = 95% Wilson interval</p></figure>`;
}

// ---------- matrices ----------
function matrix(tier, caption) {
  const tasks = TASKS.filter((t) => t.tier === tier && runs.some((r) => r.task === t.id));
  const head = `<tr><th scope="col">Task</th>${variants.map((v) => `<th scope="col">${vname(v)}</th>`).join('')}</tr>`;
  const rows = tasks
    .map((t) => {
      const tds = variants
        .map((v) => {
          const c = cells.find((x) => x.variant === v && x.task === t.id);
          if (!c) return '<td class="cell na">–</td>';
          const level = c.passRate === 1 ? 'full' : c.passRate === 0 ? 'none' : 'part';
          const extra = tier === 'k3' ? `<small>recall ${pct(c.meanRecall)}</small>` : `<small>${num(c.medianSeconds, 0)} s</small>`;
          const why = c.timeouts ? ` · ${c.timeouts} timeout${c.timeouts > 1 ? 's' : ''}` : '';
          return `<td class="cell ${level}" title="${esc(`${LABEL[v]} · ${t.id}: ${c.passes}/${c.n} passed${why}`)}"><span class="pill">${c.passes}/${c.n}</span>${extra}</td>`;
        })
        .join('');
      return `<tr><th scope="row"><span class="tname">${esc(t.capability)}</span><code>${esc(t.id)}</code></th>${tds}</tr>`;
    })
    .join('');
  return `<div class="scroll"><table class="matrix"><caption>${esc(caption)}</caption><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- tool anatomy ----------
function orcaCommandCounts(run) {
  const counts = {};
  let text = '';
  try {
    text = readFileSync(join(outDir, 'raw', run.runId, 'stream.jsonl'), 'utf8');
  } catch {
    return counts;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content || []) {
      if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
      for (const match of String(block.input?.command || '').matchAll(/\borca ([a-z-]+)/g)) counts[`orca ${match[1]}`] = (counts[`orca ${match[1]}`] || 0) + 1;
    }
  }
  return counts;
}

function topTools(v, limit = 4) {
  const counts = {};
  for (const r of runs.filter((x) => x.variant === v && x.tier !== 'k0')) {
    if (v === 'orca-browser') {
      for (const [name, n] of Object.entries(orcaCommandCounts(r))) counts[name] = (counts[name] || 0) + n;
      for (const [name, n] of Object.entries(r.toolNames || {})) if (name === 'Read') counts.Read = (counts.Read || 0) + n;
      continue;
    }
    for (const [name, n] of Object.entries(r.toolNames || {})) {
      if (name === 'StructuredOutput') continue;
      const short = name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '');
      counts[short] = (counts[short] || 0) + n;
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, n]) => `<code>${esc(name)}</code> ${Math.round((n / total) * 100)}%`)
    .join(', ');
}

// ---------- engine vs tool pairs ----------
function pairRow(a, b, label) {
  if (!variants.includes(a) || !variants.includes(b)) return '';
  const ra = score.find((s) => s.v === a);
  const rb = score.find((s) => s.v === b);
  return `<tr><th scope="row">${esc(label)}</th><td>${vname(a)}</td><td>${pct(ra.k1rate)}</td><td>${pct(ra.k2rate)}</td><td>${num(ra.medSec, 0)} s</td><td>${kTok(ra.medTok)}</td></tr>
    <tr><th scope="row"></th><td>${vname(b)}</td><td>${pct(rb.k1rate)}</td><td>${pct(rb.k2rate)}</td><td>${num(rb.medSec, 0)} s</td><td>${kTok(rb.medTok)}</td></tr>`;
}

// ---------- findings ----------
const findings = meta.findings || [];
const limitations = meta.limitations || [];

const tierRange = (tier, metric) =>
  variants.map((v) => {
    const list = tierRuns(tier, v).map(metric);
    return { v, mid: median(list), lo: quantile(list, 0.25), hi: quantile(list, 0.75) };
  });

const totalCost = runs.reduce((s, r) => s + (r.costUsd || 0), 0);
const firstRun = runs.map((r) => r.startedAt).sort()[0];
const lastRun = runs.map((r) => r.startedAt).sort().at(-1);
const viewports = Object.fromEntries(variants.map((v) => [v, runs.find((r) => r.variant === v && r.viewport)?.viewport]));
const trusted = Object.fromEntries(
  variants.map((v) => {
    const list = runs.filter((r) => r.variant === v && r.trusted !== null && r.pass);
    return [v, list.length ? list.filter((r) => r.trusted).length / list.length : null];
  }),
);

const html = `<title>Five Ways to Drive a Browser</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@500;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
/* Layout: one reading column for prose; figures and tables break out to a wider measure. */
:root{
  --paper:#f7f8f6; --panel:#ffffff; --ink:#15191d; --ink-2:#4a525a; --ink-3:#737b83; --rule:#dde1dd; --accent:#0f6e6a;
  --good:#1f7a3a; --good-bg:#e3f2e6; --part:#8a5a00; --part-bg:#fbf0d9; --bad:#a3322f; --bad-bg:#f9e3e1;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4;
  --display:"Schibsted Grotesk","Helvetica Neue",Arial,sans-serif; --body:"Source Serif 4",Georgia,"Times New Roman",serif; --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;
  --paper:#141716; --panel:#1b1f1e; --ink:#eef1ef; --ink-2:#b9c1bd; --ink-3:#8d9692; --rule:#2f3533; --accent:#5cc4bd;
  --good:#7fd69a; --good-bg:#17301f; --part:#f0c46a; --part-bg:#352a12; --bad:#f19a95; --bad-bg:#3a1c1b;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181;}}
:root[data-theme="dark"]{color-scheme:dark;
  --paper:#141716; --panel:#1b1f1e; --ink:#eef1ef; --ink-2:#b9c1bd; --ink-3:#8d9692; --rule:#2f3533; --accent:#5cc4bd;
  --good:#7fd69a; --good-bg:#17301f; --part:#f0c46a; --part-bg:#352a12; --bad:#f19a95; --bad-bg:#3a1c1b;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181;}
*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);font:17px/1.6 var(--body);margin:0;padding-inline:20px;padding-block:0 64px}
.wrap{max-width:1040px;margin:0 auto}
.prose{max-width:68ch}
header.top{padding-block:48px 24px;border-bottom:1px solid var(--rule);margin-bottom:32px}
.eyebrow{font:600 12px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 14px}
h1{font:800 clamp(34px,5vw,54px)/1.05 var(--display);letter-spacing:-.02em;margin:0 0 16px;text-wrap:balance}
h2{font:700 26px/1.2 var(--display);letter-spacing:-.01em;margin:56px 0 12px;text-wrap:balance}
h3{font:700 18px/1.3 var(--display);margin:28px 0 8px}
.dek{font-size:20px;color:var(--ink-2);max-width:62ch;margin:0}
.runline{font:13px/1.5 var(--mono);color:var(--ink-3);margin-top:18px}
p{margin:0 0 14px} a{color:var(--accent)}
code{font:0.84em var(--mono);background:color-mix(in oklab,var(--rule) 45%,transparent);padding:1px 5px;border-radius:4px}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px;vertical-align:0}
.s1{background:var(--s1)}.s2{background:var(--s2)}.s3{background:var(--s3)}.s4{background:var(--s4)}.s5{background:var(--s5)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font:14px/1.4 var(--display);font-variant-numeric:tabular-nums}
caption{text-align:left;font:600 12px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding-bottom:10px}
th,td{padding:9px 10px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
thead th{font-weight:700;color:var(--ink-2);white-space:nowrap}
td.n{text-align:right;white-space:nowrap}
.score td.n strong{font-weight:700}
.matrix th[scope=row]{min-width:220px}
.score th[scope=row],td .vn{white-space:nowrap}
.matrix .tname{display:block;font-weight:600}.matrix code{font-size:11px;color:var(--ink-3);background:none;padding:0}
.cell{white-space:nowrap}.cell small{display:block;color:var(--ink-3);font:11px var(--mono);margin-top:3px}
.pill{display:inline-block;font:600 12px var(--mono);padding:2px 8px;border-radius:999px}
.cell.full .pill{background:var(--good-bg);color:var(--good)}.cell.part .pill{background:var(--part-bg);color:var(--part)}.cell.none .pill{background:var(--bad-bg);color:var(--bad)}
.legend-states{display:flex;gap:18px;flex-wrap:wrap;font:13px var(--display);color:var(--ink-2);margin:10px 0 0}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:28px;margin:18px 0}
figure.chart{margin:0}
figure.chart figcaption{font:700 15px/1.3 var(--display);margin-bottom:6px}
.axis-note{font:12px var(--mono);color:var(--ink-3);margin:4px 0 0}
svg text{font-family:var(--display);fill:var(--ink)} svg .lab{font-size:13px;fill:var(--ink-2)} svg .val{font-size:12px;font-family:var(--mono);fill:var(--ink)} svg .tick{font-size:11px;font-family:var(--mono);fill:var(--ink-3)}
svg .grid{stroke:var(--rule);stroke-width:1} svg .ci{stroke:var(--ink);stroke-width:1.5;opacity:.7}
svg .rng{stroke-width:3;stroke-linecap:round;opacity:.55} svg .dot{stroke:var(--panel);stroke-width:2}
.c1{stroke:var(--s1)}.c2{stroke:var(--s2)}.c3{stroke:var(--s3)}.c4{stroke:var(--s4)}.c5{stroke:var(--s5)}
.f1{fill:var(--s1)}.f2{fill:var(--s2)}.f3{fill:var(--s3)}.f4{fill:var(--s4)}.f5{fill:var(--s5)}
svg .mark:focus{outline:none} svg .mark:focus .dot,svg .mark:hover .dot{r:8}
.findings{display:grid;gap:14px;padding:0;list-style:none;margin:18px 0}
.findings li{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:16px 18px}
.findings li strong{font-family:var(--display)}
.method dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:12px 0}
.method dt{font:600 13px var(--mono);color:var(--ink-3)} .method dd{margin:0}
details{margin:12px 0} summary{cursor:pointer;font:600 14px var(--display);color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:640px){body{font-size:16px}.method dl{grid-template-columns:1fr}}
</style>
<div class="wrap">
<header class="top">
  <p class="eyebrow">Browser automation benchmark · Claude Code</p>
  <h1>Five ways to drive a browser</h1>
  <p class="dek">The same agent, model and prompts ran ${num(runs.filter((r) => r.tier !== 'k0').length)} browser tasks through five different automation surfaces. This report compares what each one could do, how often it finished the job, and what it cost in time and tokens.</p>
  <p class="runline">${esc(meta.model || 'claude-opus-5-5')} · effort ${esc(meta.effort || 'medium')} · ${num(runs.length)} runs · ${esc((firstRun || '').slice(0, 10))} to ${esc((lastRun || '').slice(0, 10))} · list-price equivalent $${num(totalCost, 0)}</p>
</header>

<section>
  <h2>Scorecard</h2>
  <p class="prose">Capability counts the ${capabilityCount(variants[0]).total} single-skill probes a variant passed in at least two of three runs. Realistic tasks and bug hunts are multi-step jobs repeated five times each. Time, tokens and cost are medians over every run except the baseline.</p>
  <div class="scroll"><table class="score">
    <thead><tr><th scope="col">Variant</th><th scope="col">Capability</th><th scope="col">Realistic tasks</th><th scope="col">Bug hunts (recall)</th><th scope="col">Median time</th><th scope="col">Median input</th><th scope="col">Fixed context</th><th scope="col">Timeouts</th><th scope="col">Wrong but claimed done</th></tr></thead>
    <tbody>${score
      .map(
        (s) => `<tr><th scope="row">${vname(s.v)}</th><td class="n"><strong>${s.cap.solid}</strong>/${s.cap.total}</td><td class="n">${pct(s.k2rate)} <small>(${pct(s.k2ci[0])}–${pct(s.k2ci[1])})</small></td><td class="n">${pct(s.k3recall)}</td><td class="n">${num(s.medSec, 0)} s</td><td class="n">${kTok(s.medTok)}</td><td class="n">${kTok(s.baseTok)}</td><td class="n">${s.timeouts}</td><td class="n">${s.falseClaims}</td></tr>`,
      )
      .join('')}</tbody></table></div>
</section>

${findings.length ? `<section><h2>What stood out</h2><ul class="findings">${findings.map((f) => `<li><strong>${esc(f.title)}</strong> ${f.body}</li>`).join('')}</ul></section>` : ''}

<section>
  <h2>Capability probes</h2>
  <p class="prose">Each probe tests one skill on a purpose-built page, three runs per variant. A cell shows passes out of runs and the median time. The server checks every answer against what it actually received, so an agent that says it finished but never submitted the form fails.</p>
  ${tiersPresent.includes('k1') ? matrix('k1', 'Single-skill probes (K1)') : '<p>No probe runs yet.</p>'}
  <div class="legend-states"><span><span class="pill" style="background:var(--good-bg);color:var(--good)">3/3</span> passed every run</span><span><span class="pill" style="background:var(--part-bg);color:var(--part)">1/3</span> passed some runs</span><span><span class="pill" style="background:var(--bad-bg);color:var(--bad)">0/3</span> never passed</span></div>
</section>

<section>
  <h2>Realistic tasks</h2>
  <p class="prose">Eight multi-step jobs: a checkout with validation, a filtered catalog, a paginated table, a wizard with a custom date picker, a login with a code from a second tab, detail-page scraping, a shop full of pop-ups, and a pointer-driven kanban board.</p>
  ${tiersPresent.includes('k2') ? matrix('k2', 'Realistic tasks (K2)') : '<p>No realistic-task runs yet.</p>'}
  <div class="charts">
    ${rateChart({ id: 'k2-rate', title: 'Realistic tasks passed', rows: variants.map((v) => { const l = tierRuns('k2', v); const p = l.filter((r) => r.pass).length; return { v, rate: l.length ? p / l.length : null, ci: wilson(p, l.length), n: l.length }; }) })}
    ${rangeChart({ id: 'k2-time', title: 'Time per realistic task', unit: 'seconds', rows: tierRange('k2', (r) => r.durationMs / 1000) })}
  </div>
</section>

<section>
  <h2>Bug hunts</h2>
  <p class="prose">Five pages with planted problems in lettered sections: failing API calls behind normal-looking widgets, buttons that throw only in the console, accessibility faults, layouts that break only at phone width, and widgets that depend on Chromium-only APIs. Bug placement changes every run. Recall is the share of planted bugs found with the right category.</p>
  ${tiersPresent.includes('k3') ? matrix('k3', 'Bug hunts (K3): exact answers per run, with mean recall') : '<p>No bug-hunt runs yet.</p>'}
</section>

<section>
  <h2>Speed and cost</h2>
  <p class="prose">Fixed context is what a variant costs before it does anything: the tool definitions and any system prompt it adds, measured with a no-tool reply. Input tokens per run then grow with every page the agent reads, so a tool that returns compact page snapshots stays cheaper on long tasks.</p>
  <div class="charts">
    ${rangeChart({ id: 'k1-time', title: 'Time per capability probe', unit: 'seconds', rows: tierRange('k1', (r) => r.durationMs / 1000) })}
    ${rangeChart({ id: 'k1-tok', title: 'Input tokens per capability probe', unit: 'thousand tokens', rows: tierRange('k1', (r) => r.totalInputTokens / 1000) })}
    ${rangeChart({ id: 'k2-tok', title: 'Input tokens per realistic task', unit: 'thousand tokens', rows: tierRange('k2', (r) => r.totalInputTokens / 1000) })}
    ${rangeChart({ id: 'base-tok', title: 'Fixed context (baseline reply)', unit: 'thousand tokens', rows: tierRange('k0', (r) => r.totalInputTokens / 1000) })}
  </div>
</section>

<section>
  <h2>Engine or tool?</h2>
  <p class="prose">Two pairs separate the browser engine from the automation interface. Claude in Chrome and Playwright drive the same installed Chrome; Safari MCP and Playwright's WebKit build share an engine family. Where a pair differs, the interface is the likely cause.</p>
  <div class="scroll"><table><thead><tr><th scope="col">Pair</th><th scope="col">Variant</th><th scope="col">Probes passed</th><th scope="col">Realistic passed</th><th scope="col">Median time</th><th scope="col">Median input</th></tr></thead>
  <tbody>${pairRow('claude-in-chrome', 'pw-chrome', 'Same Chrome')}${pairRow('safari-mcp', 'pw-webkit', 'WebKit family')}</tbody></table></div>
</section>

<section>
  <h2>How each agent worked</h2>
  <div class="scroll"><table><thead><tr><th scope="col">Variant</th><th scope="col">Most used tools</th><th scope="col">Real input events</th><th scope="col">Viewport</th></tr></thead>
  <tbody>${variants.map((v) => `<tr><th scope="row">${vname(v)}</th><td>${topTools(v)}</td><td class="n">${pct(trusted[v])}</td><td class="n">${viewports[v] ? `${viewports[v].w}×${viewports[v].h}` : '–'}</td></tr>`).join('')}</tbody></table></div>
  <p class="prose" style="margin-top:12px">Real input events is the share of passed interaction runs where the page received trusted browser input (<code>event.isTrusted</code>) rather than events synthesized from page JavaScript.</p>
</section>

<section class="method">
  <h2>Method</h2>
  <div class="prose">
  <p>Every run is a fresh <code>claude -p</code> process with only one browser surface available: <code>--strict-mcp-config</code>, built-in tools limited to <code>Read</code> (plus <code>Bash</code> restricted to <code>orca</code> browser commands for the Orca variant), and <code>--setting-sources project</code> so no personal instructions leak in. The answer comes back through a JSON schema.</p>
  <p>Pages come from a local fixture server at a fresh origin per run (<code>run-&lt;id&gt;.localhost</code>), so cookies and storage always start empty. Expected answers are derived from a secret held only in the runner's memory. Browsers ran visible and maximized on a 1728×1117 display; a beacon on every page recorded the real viewport. Runs were ordered in shuffled blocks so each task's five variants ran back to back.</p>
  <p>Every multi-step fixture was first solved by a scripted reference solution in both Chrome and WebKit, so a failure here reflects the agent and its tools, not a broken page.</p>
  </div>
  <dl>
    ${variants.map((v) => `<dt>${esc(LABEL[v])}</dt><dd>${esc(VARIANTS[v].surface)} · ${esc(VARIANTS[v].engine)}</dd>`).join('')}
  </dl>
</section>

${limitations.length ? `<section><h2>Limits of this comparison</h2><ul class="prose">${limitations.map((l) => `<li>${l}</li>`).join('')}</ul></section>` : ''}

<section>
  <h2>Data</h2>
  <details><summary>Per-variant totals by tier</summary>
  <div class="scroll"><table><thead><tr><th scope="col">Tier</th><th scope="col">Variant</th><th scope="col">Runs</th><th scope="col">Passed</th><th scope="col">Median s</th><th scope="col">p75 s</th><th scope="col">Median tools</th><th scope="col">Median input</th><th scope="col">Median $</th></tr></thead><tbody>
  ${tiersPresent.sort().flatMap((tier) => variantTotals(runs, [tier]).sort((a, b) => ORDER.indexOf(a.variant) - ORDER.indexOf(b.variant)).map((t) => `<tr><td>${tier.toUpperCase()}</td><td>${vname(t.variant)}</td><td class="n">${t.n}</td><td class="n">${t.passes}</td><td class="n">${num(t.medianSeconds, 1)}</td><td class="n">${num(t.p75Seconds, 1)}</td><td class="n">${num(t.medianToolCalls)}</td><td class="n">${kTok(t.medianInputTokens)}</td><td class="n">${num(t.medianCostUsd, 3)}</td></tr>`)).join('')}
  </tbody></table></div></details>
</section>
</div>`;

const target = options.html ? join(ROOT, options.html) : join(outDir, 'report.html');
writeFileSync(target, html);
console.log(`wrote ${target} (${runs.length} runs)`);
