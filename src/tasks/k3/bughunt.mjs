import { page } from '../../lib/html.mjs';
import { defineTask, clientEvents, result } from '../common.mjs';
import { shuffle } from '../../lib/codes.mjs';

// Each bug-hunt page has lettered sections. The seeded truth maps every letter to a
// category; the agent answers one category per letter. Scoring counts a section as
// "flagged" when either side says it is not ok.
function sectionSchema(letters, categories) {
  return Object.fromEntries(letters.map((l) => [l, { type: 'string', enum: categories, description: `category for section ${l}` }]));
}

function scoreSections(truth, out, letters) {
  const answers = Object.fromEntries(letters.map((l) => [l, out?.[l] ?? null]));
  let truePositive = 0;
  let flagged = 0;
  let actual = 0;
  let exact = 0;
  for (const l of letters) {
    const isBug = truth[l] !== 'ok';
    const saidBug = answers[l] && answers[l] !== 'ok';
    if (isBug) actual += 1;
    if (saidBug) flagged += 1;
    if (isBug && answers[l] === truth[l]) truePositive += 1;
    if (answers[l] === truth[l]) exact += 1;
  }
  const recall = actual ? truePositive / actual : 1;
  const precision = flagged ? truePositive / flagged : actual ? 0 : 1;
  return result(exact === letters.length, { truth, answers, exact, recall, precision }, { recall, precision });
}

function assign(c, key, letters, bugs) {
  const order = shuffle(c.rng(key), letters);
  const truth = Object.fromEntries(letters.map((l) => [l, 'ok']));
  bugs.forEach((bug, i) => (truth[order[i]] = bug));
  return truth;
}

const WIDGET_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const WIDGET_NAMES = ['Revenue', 'Orders', 'Visitors', 'Refunds', 'Signups', 'Churned accounts'];
const NETWORK_CATEGORIES = ['ok', 'http-error', 'bad-data'];

function networkPlan(c) {
  const order = shuffle(c.rng('widgets'), WIDGET_LETTERS);
  const kinds = ['http-error', 'http-error', 'bad-data', 'ok-zero', 'ok', 'ok'];
  return Object.fromEntries(order.map((l, i) => [l, kinds[i]]));
}

const network = defineTask({
  id: 'k3-network',
  tier: 'k3',
  capability: 'find failing API calls',
  title: 'Dashboard with broken API calls',
  answer: sectionSchema(WIDGET_LETTERS, NETWORK_CATEGORIES),
  prompt: () =>
    'Some widgets on this dashboard are broken, but they do not show an error. For each widget A–F, classify it: "ok" (its data request succeeded and returned valid data, even if the value is zero), "http-error" (its data request failed with an HTTP error status), or "bad-data" (the request succeeded but returned missing or invalid data that the widget shows as if it were real).',
  routes: {
    'GET /': () =>
      page({
        title: 'Dashboard',
        css: `.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.w .v{font-size:32px;font-weight:700}`,
        body: `<h1>Weekly dashboard</h1><div class="grid">${WIDGET_LETTERS.map((l, i) => `<div class="card w"><div class="muted">Widget ${l}</div><h3>${WIDGET_NAMES[i]}</h3><div class="v" id="w${l}">…</div></div>`).join('')}</div>`,
        script: `for (const l of ${JSON.stringify(WIDGET_LETTERS)}) {
            fetch('api/widget/' + l).then(async (r) => {
              let v = 0;
              if (r.ok) { const d = await r.json(); v = Number(d.value) || 0; }
              document.getElementById('w' + l).textContent = v.toLocaleString('en-US');
            });
          }`,
      }),
    ...Object.fromEntries(
      WIDGET_LETTERS.map((l) => [
        `GET /api/widget/${l}`,
        (c) => {
          const kind = networkPlan(c)[l];
          if (kind === 'http-error') return { status: 500, json: { error: 'internal error' } };
          if (kind === 'bad-data') return { json: { value: null, updatedAt: null } };
          if (kind === 'ok-zero') return { json: { value: 0, updatedAt: '2026-09-28T10:00:00Z' } };
          return { json: { value: 1200 + Math.floor(c.rng(`w${l}`)() * 90000), updatedAt: '2026-09-28T10:00:00Z' } };
        },
      ]),
    ),
  },
  check: (c, out) => {
    const plan = networkPlan(c);
    const truth = Object.fromEntries(WIDGET_LETTERS.map((l) => [l, plan[l] === 'ok-zero' ? 'ok' : plan[l]]));
    return scoreSections(truth, out, WIDGET_LETTERS);
  },
});

const CONSOLE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const CONSOLE_CATEGORIES = ['ok', 'exception', 'promise-rejection'];
const ACTIONS = ['Recalculate totals', 'Refresh cache', 'Export CSV', 'Sync contacts', 'Rebuild index', 'Send digest', 'Rotate keys', 'Archive logs'];

const consoleHunt = defineTask({
  id: 'k3-console',
  tier: 'k3',
  capability: 'find console errors per action',
  title: 'Buttons that fail silently',
  answer: sectionSchema(CONSOLE_LETTERS, CONSOLE_CATEGORIES),
  prompt: () =>
    'Each section A–H has a button. Every button shows "Done", but some of them fail silently in the background. Click every button and classify each section: "ok" (no error), "exception" (an uncaught exception is thrown) or "promise-rejection" (an unhandled promise rejection happens).',
  routes: {
    'GET /': () =>
      page({
        title: 'Admin tools',
        css: `.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}`,
        body: `<h1>Admin tools</h1><div class="grid">${CONSOLE_LETTERS.map((l, i) => `<div class="card"><div class="muted">Section ${l}</div><h3>${ACTIONS[i]}</h3><button data-l="${l}">Run</button> <span id="s${l}"></span></div>`).join('')}</div>`,
        script: `document.querySelectorAll('button[data-l]').forEach((b) => b.addEventListener('click', async () => {
            const l = b.dataset.l;
            document.getElementById('s' + l).textContent = 'Done ✓';
            const data = await (await fetch('api/run/' + l, { method: 'POST' })).json();
            setTimeout(() => {
              if (data.mode === 'async') { Promise.reject(new Error('Request aborted')); return; }
              if (!data.job.settings) throw new TypeError('Cannot read retry settings of job ' + data.job.id);
              data.job.settings.retries += 1;
            }, 300);
          }));`,
      }),
    ...Object.fromEntries(
      CONSOLE_LETTERS.map((l) => [
        `POST /api/run/${l}`,
        (c) => {
          const kind = assign(c, 'console', CONSOLE_LETTERS, ['exception', 'exception', 'promise-rejection'])[l];
          c.log('run', { letter: l });
          if (kind === 'promise-rejection') return { json: { mode: 'async' } };
          if (kind === 'exception') return { json: { mode: 'sync', job: { id: `job-${l.toLowerCase()}${c.digits(`job${l}`, 3)}` } } };
          return { json: { mode: 'sync', job: { id: `job-${l.toLowerCase()}${c.digits(`job${l}`, 3)}`, settings: { retries: 0 } } } };
        },
      ]),
    ),
  },
  check: (c, out) => scoreSections(assign(c, 'console', CONSOLE_LETTERS, ['exception', 'exception', 'promise-rejection']), out, CONSOLE_LETTERS),
});

const A11Y_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const A11Y_CATEGORIES = ['ok', 'missing-label', 'broken-aria-reference', 'low-contrast', 'no-accessible-name', 'missing-alt'];
const FIELDS = ['Full name', 'Email', 'Phone', 'Company', 'Job title', 'Country', 'City', 'Website'];

function a11yTruth(c) {
  const pool = shuffle(c.rng('a11y-pool'), A11Y_CATEGORIES.slice(1)).slice(0, 4);
  return assign(c, 'a11y', A11Y_LETTERS, pool);
}

function a11ySection(letter, index, kind) {
  const id = `f${letter}`;
  const labelStyle = kind === 'low-contrast' ? ' style="color:#c8c8c8"' : '';
  const label =
    kind === 'missing-label'
      ? `<span class="lbl">${FIELDS[index]}</span>`
      : kind === 'broken-aria-reference'
        ? `<span class="lbl">${FIELDS[index]}</span>`
        : `<label for="${id}"${labelStyle}>${FIELDS[index]}</label>`;
  const inputAria = kind === 'broken-aria-reference' ? ` aria-labelledby="lbl-${letter.toLowerCase()}-text"` : '';
  const icon = kind === 'missing-alt' ? '<img src="icon.svg" width="20" height="20">' : '<img src="icon.svg" width="20" height="20" alt="">';
  const help =
    kind === 'no-accessible-name'
      ? '<button type="button" class="help"><span aria-hidden="true">?</span></button>'
      : '<button type="button" class="help" aria-label="Help">?</button>';
  return `<div class="card sec"><span class="badge" aria-hidden="true">${letter}</span>${icon} ${label}<input id="${id}"${inputAria}> ${help}</div>`;
}

const a11y = defineTask({
  id: 'k3-a11y',
  tier: 'k3',
  capability: 'accessibility audit',
  title: 'Accessibility problems in a form',
  answer: sectionSchema(A11Y_LETTERS, A11Y_CATEGORIES),
  prompt: () =>
    'Audit the accessibility of this form. Each section is marked with a letter A–H. For each section report "ok" or the single problem it has: "missing-label" (the input has no programmatic label), "broken-aria-reference" (an aria attribute points to an element that does not exist), "low-contrast" (the visible label text has insufficient color contrast), "no-accessible-name" (a button has no accessible name), or "missing-alt" (an image has no alt attribute).',
  routes: {
    'GET /': (c) => {
      const truth = a11yTruth(c);
      return page({
        title: 'Contact details',
        css: `.sec{display:flex;align-items:center;gap:10px}.sec label,.sec .lbl{margin:0;min-width:120px;font-weight:600}.badge{background:#243b6b;color:#fff;border-radius:50%;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center}
          .help{padding:2px 10px;border-radius:50%}`,
        body: `<h1>Contact details</h1><form>${A11Y_LETTERS.map((l, i) => a11ySection(l, i, truth[l])).join('')}</form>`,
      });
    },
    'GET /icon.svg': () => ({
      headers: { 'content-type': 'image/svg+xml' },
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#6b8bd6"/></svg>',
    }),
  },
  check: (c, out) => scoreSections(a11yTruth(c), out, A11Y_LETTERS),
});

const LAYOUT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const LAYOUT_CATEGORIES = ['ok', 'horizontal-overflow', 'text-clipped'];
const LONG_TEXT = 'Free returns within 60 days on all orders shipped to the continental United States and Canada.';

const responsiveHunt = defineTask({
  id: 'k3-responsive',
  tier: 'k3',
  capability: 'mobile layout bugs',
  title: 'Layout bugs at phone width',
  answer: sectionSchema(LAYOUT_LETTERS, LAYOUT_CATEGORIES),
  prompt: () =>
    'This page has layout bugs that only appear on a phone-sized screen (375 CSS pixels wide). Check the page at that width. For each section A–F report "ok", "horizontal-overflow" (content is wider than the section and sticks out or causes horizontal scrolling), or "text-clipped" (text is cut off instead of wrapping).',
  routes: {
    'GET /': (c) => {
      const truth = assign(c, 'layout', LAYOUT_LETTERS, ['horizontal-overflow', 'horizontal-overflow', 'text-clipped']);
      const section = (l) => {
        const kind = truth[l];
        const inner =
          kind === 'horizontal-overflow'
            ? `<div class="promo-strip">${LONG_TEXT}</div>`
            : kind === 'text-clipped'
              ? `<p class="policy-note">${LONG_TEXT}</p>`
              : `<p>${LONG_TEXT}</p>`;
        return `<section class="card"><h2>Section ${l}</h2>${inner}</section>`;
      };
      return page({
        title: 'Store policies',
        css: `@media (max-width: 480px){main{padding:0 8px}.promo-strip{min-width:620px;background:#eef2fb}.policy-note{white-space:nowrap;overflow:hidden;text-overflow:clip}}`,
        body: `<h1>Store policies</h1>${LAYOUT_LETTERS.map(section).join('')}`,
      });
    },
  },
  check: (c, out, events) => {
    const widths = [...clientEvents(events, 'pageview'), ...clientEvents(events, 'resize')].map((e) => e.data.w);
    const scored = scoreSections(assign(c, 'layout', LAYOUT_LETTERS, ['horizontal-overflow', 'horizontal-overflow', 'text-clipped']), out, LAYOUT_LETTERS);
    scored.details.narrowViewportSeen = widths.some((w) => w <= 480);
    return scored;
  },
});

const ENGINE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const ENGINE_SNIPPETS = {
  // Chromium-only APIs: these fail in WebKit.
  uaData: { title: 'Browser brand', code: 'navigator.userAgentData.brands.map((b) => b.brand).join(", ")' },
  connection: { title: 'Connection type', code: 'navigator.connection.effectiveType.toUpperCase()' },
  // Broken in every engine.
  typo: { title: 'Local time', code: 'new Intl.DateTimeFormat("en-US").formatt(new Date())' },
  // Work everywhere.
  number: { title: 'Price format', code: 'new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(1234.5)' },
  list: { title: 'Team list', code: 'new Intl.ListFormat("en", { type: "conjunction" }).format(["Ana", "Bo", "Cy"])' },
  random: { title: 'Request ID', code: 'crypto.randomUUID().slice(0, 8)' },
};

function enginePlan(c) {
  const order = shuffle(c.rng('engine'), ENGINE_LETTERS);
  return Object.fromEntries(Object.keys(ENGINE_SNIPPETS).map((key, i) => [order[i], key]));
}

const engine = defineTask({
  id: 'k3-engine',
  tier: 'k3',
  capability: 'engine-specific breakage',
  title: 'Widgets that break in some browsers',
  answer: sectionSchema(ENGINE_LETTERS, ['ok', 'broken']),
  prompt: () =>
    'Some widgets on this page do not work in the browser you are using. A broken widget shows a dash instead of a value and logs an error. For each section A–F report "ok" or "broken" as it behaves in your browser.',
  routes: {
    'GET /': (c) => {
      const plan = enginePlan(c);
      return page({
        title: 'Environment',
        css: `.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.v{font-size:20px;font-weight:600}`,
        body: `<h1>Environment report</h1><div class="grid">${ENGINE_LETTERS.map((l) => `<div class="card"><div class="muted">Section ${l}</div><h3>${ENGINE_SNIPPETS[plan[l]].title}</h3><div class="v" id="v${l}">…</div></div>`).join('')}</div>`,
        script: ENGINE_LETTERS.map(
          (l) => `setTimeout(() => {
            let value = '—', failed = false;
            try { value = ${ENGINE_SNIPPETS[plan[l]].code}; } catch (error) { failed = true; console.error('Widget failed:', error.message); }
            document.getElementById('v${l}').textContent = failed ? '—' : value;
            __bench('engine-section', { letter: '${l}', failed });
          }, 200);`,
        ).join('\n'),
      });
    },
  },
  // Truth comes from what each section did in this run's browser, reported by the page.
  check: (c, out, events) => {
    const reports = clientEvents(events, 'engine-section');
    const truth = Object.fromEntries(ENGINE_LETTERS.map((l) => [l, reports.findLast((e) => e.data.letter === l)?.data.failed ? 'broken' : 'ok']));
    const scored = scoreSections(truth, out, ENGINE_LETTERS);
    scored.details.plan = enginePlan(c);
    scored.details.reported = reports.length > 0;
    return scored;
  },
});

export default [network, consoleHunt, a11y, responsiveHunt, engine];
