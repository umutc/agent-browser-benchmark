import { page } from '../../lib/html.mjs';
import { defineTask, str, norm, serverEvents, trustedInput, result } from '../common.mjs';

function voucherFrame() {
  return page({
    title: 'Partner widget',
    bare: true,
    css: 'body{padding:16px;background:#fffbe8}',
    body: `<h2>Partner rewards</h2><button id="get">Get voucher</button><p id="out"></p>`,
    script: `document.getElementById('get').addEventListener('click', async (event) => {
      __bench('click', { trusted: event.isTrusted });
      const data = await (await fetch('voucher', { method: 'POST' })).json();
      document.getElementById('out').textContent = 'Voucher: ' + data.code;
    });`,
  });
}

function iframeTask({ id, capability, title, frameUrl }) {
  return defineTask({
    id,
    tier: 'k1',
    capability,
    title,
    answer: { voucher: str('the voucher code shown inside the widget') },
    prompt: () =>
      'The page contains an embedded partner widget (an iframe). Click the "Get voucher" button inside the widget and report the voucher code it shows.',
    routes: {
      'GET /': (c) =>
        page({
          title: 'Checkout offers',
          body: `<div class="card"><h1>Offers</h1><p>Our partner has a reward for you:</p>
            <iframe src="${frameUrl(c)}" width="640" height="220" style="border:1px solid #ccd;border-radius:8px"></iframe></div>`,
        }),
      'GET /frame': () => voucherFrame(),
      'POST /voucher': (c) => {
        c.log('voucher', { crossOrigin: c.isCrossOrigin });
        return { json: { code: c.code('v') } };
      },
    },
    check: (c, out, events) =>
      result(norm(out?.voucher) === c.code('v') && serverEvents(events, 'voucher').length > 0, { got: out?.voucher }, {
        trusted: trustedInput(events, 'click'),
      }),
  });
}

const iframe = iframeTask({
  id: 'k1-iframe',
  capability: 'iframe (same origin)',
  title: 'Same-origin iframe',
  frameUrl: () => 'frame',
});

const iframeCrossOrigin = iframeTask({
  id: 'k1-iframe-xo',
  capability: 'iframe (cross origin)',
  title: 'Cross-origin iframe',
  frameUrl: (c) => c.xurl('/frame'),
});

const couponWord = (c) => `trail-${c.code('w', 4).toLowerCase()}`;

const shadow = defineTask({
  id: 'k1-shadow',
  tier: 'k1',
  capability: 'shadow DOM',
  title: 'Nested shadow DOM',
  answer: { code: str('the confirmation code shown after applying the coupon') },
  prompt: (c) =>
    `In the "Coupon" box, type ${couponWord(c)} into the coupon field and click "Apply". Report the confirmation code that appears.`,
  routes: {
    'GET /': () =>
      page({
        title: 'Cart',
        body: `<div class="card"><h1>Your cart</h1><p>2 items, subtotal $84.00</p><acme-coupon></acme-coupon></div>`,
        script: `class AcmeField extends HTMLElement {
            constructor() {
              super();
              const root = this.attachShadow({ mode: 'open' });
              root.innerHTML = '<style>input{font:inherit;padding:6px;border:1px solid #999;border-radius:4px}button{font:inherit;padding:6px 14px;margin-left:8px}</style><input placeholder="Coupon code"><button>Apply</button><p class="msg"></p>';
              root.querySelector('button').addEventListener('click', async (event) => {
                __bench('click', { trusted: event.isTrusted });
                const word = root.querySelector('input').value;
                const data = await (await fetch('apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ word }) })).json();
                root.querySelector('.msg').textContent = data.message;
              });
            }
          }
          class AcmeCoupon extends HTMLElement {
            constructor() {
              super();
              const root = this.attachShadow({ mode: 'open' });
              root.innerHTML = '<style>.box{border:1px solid #ccd;border-radius:8px;padding:12px;margin-top:12px}</style><div class="box"><h3>Coupon</h3><acme-field></acme-field></div>';
            }
          }
          customElements.define('acme-field', AcmeField);
          customElements.define('acme-coupon', AcmeCoupon);`,
      }),
    'POST /apply': (c, req) => {
      const { word } = req.json();
      c.log('apply', { word });
      const ok = word === couponWord(c);
      return { json: { message: ok ? `Coupon applied. Confirmation: ${c.code('c')}` : 'Unknown coupon.' } };
    },
  },
  check: (c, out, events) => {
    const applied = serverEvents(events, 'apply').some((e) => e.data.word === couponWord(c));
    return result(applied && norm(out?.code) === c.code('c'), { applied, got: out?.code }, {
      trusted: trustedInput(events, 'click'),
    });
  },
});

const popup = defineTask({
  id: 'k1-popup',
  tier: 'k1',
  capability: 'new tab / popup',
  title: 'Popup window',
  answer: { receipt: str('the receipt code shown in the new tab') },
  prompt: () => 'Click "Open receipt". It opens the receipt in a new tab or window. Report the receipt code shown there.',
  routes: {
    'GET /': () =>
      page({
        title: 'Orders',
        body: `<div class="card"><h1>Order #10492</h1><p>Paid on delivery.</p><button id="open">Open receipt</button></div>`,
        script: `let token = null;
          fetch('token', { method: 'POST' }).then((r) => r.json()).then((d) => { token = d.token; });
          document.getElementById('open').addEventListener('click', (event) => {
            __bench('click', { trusted: event.isTrusted });
            if (token) window.open('receipt?t=' + token, '_blank');
          });`,
      }),
    'POST /token': (c) => ({ json: { token: c.code('t', 10) } }),
    'GET /receipt': (c, req) => {
      const ok = req.query.get('t') === c.code('t', 10);
      if (ok) c.log('receipt-view');
      return page({
        title: 'Receipt',
        body: ok
          ? `<div class="card"><h1>Receipt</h1><p>Receipt code: <strong>${c.code('r')}</strong></p></div>`
          : '<div class="card"><h1>Invalid receipt link</h1></div>',
      });
    },
  },
  check: (c, out, events) =>
    result(norm(out?.receipt) === c.code('r') && serverEvents(events, 'receipt-view').length > 0, { got: out?.receipt }, {
      trusted: trustedInput(events, 'click'),
    }),
});

const TARGET_ITEM = 87;
const PAGE_SIZE = 20;
const TOTAL_ITEMS = 160;

const scroll = defineTask({
  id: 'k1-scroll',
  tier: 'k1',
  capability: 'infinite scroll',
  title: 'Infinite scroll',
  answer: { reference: str(`the reference code of item #${TARGET_ITEM}`) },
  prompt: () => `This page loads more items as you scroll down the list. Find item #${TARGET_ITEM} and report its reference code.`,
  routes: {
    'GET /': () =>
      page({
        title: 'Catalog',
        css: `.row{background:#fff;border:1px solid #e3e6ee;border-radius:6px;padding:14px;margin:8px 0}#sentinel{height:40px}`,
        body: `<h1>All items</h1><div id="list"></div><div id="sentinel" class="muted">Loading…</div>`,
        script: `let cursor = 'start';
          let busy = false;
          async function more() {
            if (busy || !cursor) return;
            busy = true;
            await new Promise((r) => setTimeout(r, 400));
            const data = await (await fetch('items?cursor=' + encodeURIComponent(cursor))).json();
            const list = document.getElementById('list');
            for (const item of data.items) {
              const row = document.createElement('div');
              row.className = 'row';
              row.textContent = 'Item #' + item.n + ' · ' + item.name + ' · reference ' + item.ref;
              list.appendChild(row);
            }
            cursor = data.next;
            if (!cursor) document.getElementById('sentinel').textContent = 'End of list';
            busy = false;
            if (cursor && document.getElementById('sentinel').getBoundingClientRect().top < innerHeight) more();
          }
          new IntersectionObserver((entries) => { if (entries[0].isIntersecting) more(); }).observe(document.getElementById('sentinel'));`,
      }),
    'GET /items': (c, req) => {
      const cursor = req.query.get('cursor');
      let pageIndex = -1;
      if (cursor === 'start') pageIndex = 0;
      for (let i = 1; i * PAGE_SIZE < TOTAL_ITEMS; i++) if (cursor === c.code(`cursor${i}`, 8)) pageIndex = i;
      if (pageIndex < 0) return { status: 400, json: { error: 'bad cursor' } };
      c.log('items', { page: pageIndex });
      const items = [];
      for (let n = pageIndex * PAGE_SIZE + 1; n <= Math.min(TOTAL_ITEMS, (pageIndex + 1) * PAGE_SIZE); n++) {
        items.push({ n, name: `Trail gear ${n}`, ref: c.code(`item${n}`, 5) });
      }
      const nextIndex = pageIndex + 1;
      const next = nextIndex * PAGE_SIZE < TOTAL_ITEMS ? c.code(`cursor${nextIndex}`, 8) : null;
      return { json: { items, next } };
    },
  },
  check: (c, out) => result(norm(out?.reference) === c.code(`item${TARGET_ITEM}`, 5), { got: out?.reference }),
});

const deleteWord = (c) => c.code('w', 5);

const dialogs = defineTask({
  id: 'k1-dialogs',
  tier: 'k1',
  capability: 'JS dialogs (confirm + prompt)',
  title: 'confirm() and prompt() dialogs',
  answer: { code: str('the code shown on the page after the deletion') },
  prompt: () =>
    'Click "Delete demo data". Accept the confirmation dialog. A second dialog asks you to type a confirmation word that appears only in that dialog; type it and accept. Report the code shown on the page afterwards.',
  routes: {
    'GET /word': (c) => ({ json: { word: deleteWord(c) } }),
    'GET /': () =>
      page({
        title: 'Settings',
        body: `<div class="card"><h1>Danger zone</h1><p>Remove all demo records from this workspace.</p>
          <button id="del">Delete demo data</button><div id="out" class="result" hidden></div></div>`,
        script: `let word = '';
          fetch('word').then((r) => r.json()).then((d) => { word = d.word; });
          document.getElementById('del').addEventListener('click', async (event) => {
          __bench('click', { trusted: event.isTrusted });
          const out = document.getElementById('out');
          out.hidden = false;
          if (!confirm('Delete demo data? This cannot be undone.')) { out.textContent = 'Cancelled.'; return; }
          const typed = prompt('Type ' + word + ' to confirm deletion');
          const data = await (await fetch('confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ typed }) })).json();
          out.textContent = data.message;
        });`,
      }),
    'POST /confirm': (c, req) => {
      const { typed } = req.json();
      c.log('confirm', { typed });
      const ok = (typed || '').trim().toUpperCase() === deleteWord(c);
      return { json: { message: ok ? `Demo data deleted. Code: ${c.code('c')}` : 'Wrong confirmation word. Nothing was deleted.' } };
    },
  },
  check: (c, out, events) => {
    const confirmed = serverEvents(events, 'confirm').some((e) => (e.data.typed || '').trim().toUpperCase() === deleteWord(c));
    return result(confirmed && norm(out?.code) === c.code('c'), { confirmed, got: out?.code });
  },
});

export default [iframe, iframeCrossOrigin, shadow, popup, scroll, dialogs];
