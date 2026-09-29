import { page } from '../../lib/html.mjs';
import { textToRects } from '../../lib/pixelfont.mjs';
import { defineTask, str, norm, serverEvents, clientEvents, result } from '../common.mjs';

const consoleProbe = defineTask({
  id: 'k1-console',
  tier: 'k1',
  capability: 'console messages',
  title: 'Read a console error',
  answer: { token: str('the token in the console error message') },
  prompt: () => 'When this page loads it writes an error message to the browser console. Report the token contained in that console error message.',
  routes: {
    'GET /': () =>
      page({
        title: 'Status',
        body: `<div class="card"><h1>System status</h1><p>All systems operational.</p></div>`,
        script: `fetch('diag').then((r) => r.json()).then((d) => {
          console.error('Integrity check failed: token ' + d.token);
          console.log('status page ready');
        });`,
      }),
    'GET /diag': (c) => {
      c.log('diag');
      return { json: { token: c.code('e') } };
    },
  },
  check: (c, out) => result(norm(out?.token) === c.code('e'), { got: out?.token }),
});

const network = defineTask({
  id: 'k1-network',
  tier: 'k1',
  capability: 'network request body',
  title: 'Read a request body',
  answer: { syncId: str('the syncId value from the request body') },
  prompt: () =>
    'When this page loads it sends a POST request to an endpoint ending in /sync. Report the value of the "syncId" field in that request\'s JSON body.',
  routes: {
    'GET /': () =>
      page({
        title: 'Sync',
        body: `<div class="card"><h1>Preferences</h1><p>Your preferences are synced automatically.</p></div>`,
        script: `fetch('seed').then((r) => r.json()).then((d) =>
          fetch('sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ syncId: d.seed, client: 'web', version: 3 }) }));`,
      }),
    'GET /seed': (c) => {
      c.state.seeds ??= 0;
      c.state.seeds += 1;
      return { json: { seed: c.code(`seed${c.state.seeds}`, 8) } };
    },
    'POST /sync': (c, req) => {
      c.log('sync', { syncId: req.json().syncId });
      return { status: 204 };
    },
  },
  // /seed returns a new value on every call, so re-fetching it from a script gives a
  // value the page never sent; only a syncId the server actually received counts.
  check: (c, out, events) => {
    const received = serverEvents(events, 'sync').map((e) => e.data.syncId);
    return result(received.includes(norm(out?.syncId)), { got: out?.syncId, received });
  },
});

const SALT_KEY = 'salt';

function checksum(salt, input) {
  let hash = 0x811c9dc5;
  for (const char of `${salt}:${input}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const evalArg = (c) => c.code('arg').toLowerCase();

const evaluate = defineTask({
  id: 'k1-eval',
  tier: 'k1',
  capability: 'run JavaScript',
  title: 'Call a page function',
  answer: { value: str('the value returned by acmeChecksum') },
  prompt: (c) => `Run the page's JavaScript function acmeChecksum with the argument "${evalArg(c)}" and report the returned value.`,
  routes: {
    'GET /': (c) =>
      page({
        title: 'Developer tools',
        body: `<div class="card"><h1>Integration helpers</h1><p>This page exposes a JavaScript function <code>acmeChecksum(text)</code>.</p></div>`,
        script: `window.acmeChecksum = function (input) {
          let hash = 0x811c9dc5;
          for (const char of ${JSON.stringify(c.code(SALT_KEY, 8))} + ':' + input) {
            hash ^= char.charCodeAt(0);
            hash = Math.imul(hash, 0x01000193) >>> 0;
          }
          return hash.toString(16).padStart(8, '0');
        };`,
      }),
  },
  check: (c, out) => {
    const expected = checksum(c.code(SALT_KEY, 8), evalArg(c));
    return result(String(out?.value ?? '').trim().toLowerCase() === expected, { expected, got: out?.value });
  },
});

const LOREM =
  'Trail running is a sport that combines running and, where there are steep inclines, hiking. It differs from road running in that it takes place on hiking trails, often single track, and follows the terrain.';

const canvas = defineTask({
  id: 'k1-canvas',
  tier: 'k1',
  capability: 'screenshot + vision (below the fold)',
  title: 'Read a code drawn on a canvas',
  answer: { code: str('the 6-character code drawn in the image') },
  prompt: () => 'Near the bottom of this long page there is an image (a canvas) showing a 6-character code. Report the code.',
  routes: {
    'GET /': () =>
      page({
        title: 'Trail guide',
        body: `<h1>The complete trail guide</h1>
          ${Array.from({ length: 18 }, (_, i) => `<div class="card"><h2>Chapter ${i + 1}</h2><p>${LOREM}</p><p>${LOREM}</p></div>`).join('')}
          <div class="card"><h2>Your badge</h2><canvas id="badge" width="10" height="10" style="background:#fff"></canvas></div>`,
        script: `fetch('glyphs').then((r) => r.json()).then((g) => {
          const canvas = document.getElementById('badge');
          canvas.width = g.width; canvas.height = g.height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#f2f5fb'; ctx.fillRect(0, 0, g.width, g.height);
          ctx.fillStyle = '#1d2330';
          for (const [x, y, w, h] of g.rects) ctx.fillRect(x, y, w, h);
        });`,
      }),
    'GET /glyphs': (c) => ({ json: textToRects(c.code('g')) }),
  },
  check: (c, out) => result(norm(out?.code) === c.code('g'), { expected: c.code('g'), got: out?.code }),
});

const responsive = defineTask({
  id: 'k1-responsive',
  tier: 'k1',
  capability: 'resize viewport',
  title: 'Mobile-only content',
  answer: { code: str('the mobile-only offer code') },
  prompt: () =>
    'This page reveals a mobile-only offer code when the browser viewport is 480 CSS pixels wide or narrower. Make the viewport that narrow, then report the offer code.',
  routes: {
    'GET /': () =>
      page({
        title: 'Offers',
        body: `<div class="card"><h1>Offers</h1><p>Some offers are only available on phones.</p><div id="out" class="result" hidden></div></div>`,
        script: `const query = matchMedia('(max-width: 480px)');
          let shown = false;
          async function check() {
            if (!query.matches || shown) return;
            shown = true;
            const data = await (await fetch('mobile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ w: innerWidth }) })).json();
            const out = document.getElementById('out');
            out.hidden = false;
            out.textContent = 'Mobile offer code: ' + data.code;
          }
          query.addEventListener('change', check);
          check();`,
      }),
    'POST /mobile': (c, req) => {
      c.log('mobile', { w: req.json().w });
      return { json: { code: c.code('m') } };
    },
  },
  check: (c, out, events) => {
    const widths = [
      ...clientEvents(events, 'pageview'),
      ...clientEvents(events, 'resize'),
      ...serverEvents(events, 'mobile'),
    ].map((e) => e.data.w);
    const narrow = widths.some((w) => w <= 480);
    return result(narrow && norm(out?.code) === c.code('m'), { narrow, minWidth: Math.min(...widths), got: out?.code });
  },
});

const print = defineTask({
  id: 'k1-print',
  tier: 'k1',
  capability: 'emulate print media',
  title: 'Print-only content',
  answer: { code: str('the code that appears in the print version') },
  prompt: () =>
    'This page shows an extra code only in its print version (print media). Switch the page to print media, for example by emulating the print CSS media type, and report the code that appears.',
  routes: {
    'GET /': () =>
      page({
        title: 'Invoice',
        css: `.print-only{display:none}@media print{.print-only{display:block}}`,
        body: `<div class="card"><h1>Invoice 2024-118</h1><p>Total due: $420.00</p><div class="print-only result" id="out"></div></div>`,
        script: `let loaded = false;
          async function load() {
            if (loaded) return;
            loaded = true;
            const data = await (await fetch('print-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media: matchMedia('print').matches }) })).json();
            document.getElementById('out').textContent = 'Print verification code: ' + data.code;
          }
          const query = matchMedia('print');
          query.addEventListener('change', (event) => { if (event.matches) load(); });
          addEventListener('beforeprint', load);
          if (query.matches) load();`,
      }),
    'POST /print-code': (c, req) => {
      c.log('print-code', { media: req.json().media });
      return { json: { code: c.code('p') } };
    },
  },
  check: (c, out, events) => {
    const printMedia = serverEvents(events, 'print-code').some((e) => e.data.media === true);
    return result(printMedia && norm(out?.code) === c.code('p'), { printMedia, got: out?.code });
  },
});

export default [consoleProbe, network, evaluate, canvas, responsive, print];
