import { page } from '../../lib/html.mjs';
import { defineTask, str, num, norm, serverEvents, trustedInput, result } from '../common.mjs';

const PRODUCTS = [
  { sku: 'lantern', name: 'Trail Lantern', cents: 3400 },
  { sku: 'mug', name: 'Camp Mug', cents: 1250 },
  { sku: 'stove', name: 'Pocket Stove', cents: 5900 },
  { sku: 'hammock', name: 'Ultralight Hammock', cents: 7400 },
  { sku: 'filter', name: 'Water Filter', cents: 3900 },
  { sku: 'knife', name: 'Folding Knife', cents: 2800 },
];
const DISCOUNT = 0.2;
const coupon = (c) => `SAVE20-${c.code('coupon', 4)}`;

function cartTotals(c) {
  const cart = c.state.cart || {};
  const subtotal = PRODUCTS.reduce((sum, p) => sum + (cart[p.sku] || 0) * p.cents, 0);
  const discount = c.state.couponApplied ? Math.round(subtotal * DISCOUNT) : 0;
  return { cart, subtotal, discount, total: subtotal - discount };
}

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

const overlays = defineTask({
  id: 'k2-overlays',
  tier: 'k2',
  capability: 'overlays, modals, toasts',
  title: 'Shop through banners and pop-ups',
  answer: { total: num('the grand total shown in the cart, in dollars') },
  prompt: (c) =>
    `Add 2 × "Trail Lantern" and 1 × "Camp Mug" to the cart, open the cart, apply the coupon code ${coupon(c)}, and report the grand total shown in the cart. Decline any cookie banner or newsletter pop-up (choose the reject or no-thanks option).`,
  routes: {
    'GET /': () =>
      page({
        title: 'Shop',
        css: `.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.qty{display:flex;align-items:center;gap:6px;margin:8px 0}
          .qty button{padding:2px 10px}.overlay{position:fixed;inset:0;background:#0008;display:flex;align-items:flex-end;justify-content:center;z-index:50}
          .banner{background:#fff;width:100%;padding:20px 32px;display:flex;justify-content:space-between;align-items:center}
          .modal{position:fixed;inset:0;background:#0006;display:flex;align-items:center;justify-content:center;z-index:40}
          .modal .box{background:#fff;border-radius:10px;padding:28px;width:420px}
          #toasts{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:60}.toast{background:#1d2330;color:#fff;padding:10px 16px;border-radius:6px}`,
        body: `<div style="display:flex;justify-content:space-between;align-items:center"><h1>Camp shop</h1><a class="btn" href="cart">Cart (<span id="count">0</span>)</a></div>
          <div class="grid">${PRODUCTS.map((p) => `<div class="card" data-sku="${p.sku}"><h3>${p.name}</h3><p>${money(p.cents)}</p>
            <div class="qty"><button class="secondary" data-act="dec" aria-label="Decrease quantity of ${p.name}">−</button><span class="n">1</span><button class="secondary" data-act="inc" aria-label="Increase quantity of ${p.name}">+</button></div>
            <button data-act="add">Add to cart</button></div>`).join('')}</div>
          <div class="overlay" id="consent"><div class="banner"><div><strong>We use cookies</strong><p class="muted">We use cookies to improve your experience.</p></div>
            <div><button class="secondary" id="reject">Reject all</button> <button id="accept">Accept all</button></div></div></div>
          <div class="modal" id="newsletter" hidden><div class="box"><h2>Get 10% off</h2><p>Join our newsletter for deals.</p><input placeholder="Email" size="30">
            <div style="margin-top:12px"><button id="join">Subscribe</button> <button class="secondary" id="nothanks">No thanks</button></div></div></div>
          <div id="toasts"></div>`,
        script: `const toast = (text) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; toasts.appendChild(t); setTimeout(() => t.remove(), 4000); };
          async function consent(choice) {
            await fetch('api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice }) });
            document.getElementById('consent').remove();
            setTimeout(() => (document.getElementById('newsletter').hidden = false), 2500);
          }
          reject.onclick = () => consent('reject');
          accept.onclick = () => consent('accept');
          nothanks.onclick = () => { newsletter.hidden = true; fetch('api/newsletter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'no' }) }); };
          join.onclick = () => { newsletter.hidden = true; fetch('api/newsletter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'yes' }) }); };
          document.querySelectorAll('[data-sku]').forEach((card) => {
            const n = card.querySelector('.n');
            card.addEventListener('click', async (event) => {
              const act = event.target.dataset.act;
              if (act === 'inc') n.textContent = Number(n.textContent) + 1;
              if (act === 'dec') n.textContent = Math.max(1, Number(n.textContent) - 1);
              if (act !== 'add') return;
              __bench('click', { trusted: event.isTrusted });
              const data = await (await fetch('api/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: card.dataset.sku, qty: Number(n.textContent) }) })).json();
              count.textContent = data.count;
              toast('Added ' + n.textContent + ' × ' + card.querySelector('h3').textContent);
              n.textContent = 1;
            });
          });
          fetch('api/cart').then((r) => r.json()).then((d) => (count.textContent = d.count));`,
      }),
    'POST /api/consent': (c, req) => {
      c.state.consent = req.json().choice;
      c.log('consent', { choice: c.state.consent });
      return { json: { ok: true } };
    },
    'POST /api/newsletter': (c, req) => {
      c.log('newsletter', { choice: req.json().choice });
      return { json: { ok: true } };
    },
    'GET /api/cart': (c) => ({ json: { count: Object.values(c.state.cart || {}).reduce((a, b) => a + b, 0) } }),
    'POST /api/cart': (c, req) => {
      const { sku, qty } = req.json();
      c.state.cart ??= {};
      if (PRODUCTS.some((p) => p.sku === sku)) c.state.cart[sku] = (c.state.cart[sku] || 0) + Math.max(1, Number(qty) || 1);
      c.log('cart-add', { sku, qty });
      return { json: { count: Object.values(c.state.cart).reduce((a, b) => a + b, 0) } };
    },
    'GET /cart': (c) => {
      const { cart, subtotal, discount, total } = cartTotals(c);
      const lines = PRODUCTS.filter((p) => cart[p.sku]).map((p) => `<tr><td>${p.name}</td><td>${cart[p.sku]}</td><td>${money(p.cents * cart[p.sku])}</td>
        <td><form method="post" action="cart/remove" style="margin:0"><input type="hidden" name="sku" value="${p.sku}"><button class="secondary">Remove</button></form></td></tr>`);
      return page({
        title: 'Cart',
        body: `<div class="card"><a href="./">‹ Continue shopping</a><h1>Your cart</h1>
          <table><tr><th>Item</th><th>Qty</th><th>Price</th><th></th></tr>${lines.join('') || '<tr><td colspan="4">Your cart is empty.</td></tr>'}</table>
          <form method="post" action="cart/coupon" style="margin-top:16px"><label for="coupon">Coupon code</label><input id="coupon" name="coupon"> <button>Apply</button></form>
          ${c.state.couponMessage ? `<p class="muted">${c.state.couponMessage}</p>` : ''}
          <table style="margin-top:16px;max-width:360px"><tr><td>Subtotal</td><td>${money(subtotal)}</td></tr>
          <tr><td>Discount</td><td>−${money(discount)}</td></tr><tr><th>Grand total</th><th>${money(total)}</th></tr></table></div>`,
      });
    },
    'POST /cart/coupon': (c, req) => {
      const given = (req.form().coupon || '').trim().toUpperCase();
      c.state.couponApplied = given === coupon(c);
      c.state.couponMessage = c.state.couponApplied ? 'Coupon applied: 20% off.' : 'That coupon code is not valid.';
      c.log('coupon', { ok: c.state.couponApplied });
      return { redirect: '../cart' };
    },
    'POST /cart/remove': (c, req) => {
      const sku = req.form().sku;
      if (c.state.cart) delete c.state.cart[sku];
      c.log('cart-remove', { sku });
      return { redirect: '../cart' };
    },
  },
  check: (c, out, events) => {
    const { cart, total } = cartTotals(c);
    const cartOk = cart.lantern === 2 && cart.mug === 1 && Object.keys(cart).filter((k) => cart[k]).length === 2;
    const couponOk = c.state.couponApplied === true;
    const declined = serverEvents(events, 'consent').at(-1)?.data.choice === 'reject';
    const answer = Math.abs(Number(out?.total) - total / 100) < 0.01;
    return result(cartOk && couponOk && declined && answer, { cart, couponOk, declined, expectedTotal: total / 100, got: out?.total }, {
      trusted: trustedInput(events, 'click'),
    });
  },
});

const COLUMNS = ['todo', 'doing', 'done'];
const COLUMN_TITLES = { todo: 'To Do', doing: 'In Progress', done: 'Done' };
const CARDS = [
  { id: 'c1', title: 'Fix login bug', column: 'todo' },
  { id: 'c2', title: 'Write docs', column: 'todo' },
  { id: 'c3', title: 'Update icons', column: 'todo' },
  { id: 'c4', title: 'Review pricing page', column: 'doing' },
  { id: 'c5', title: 'Plan release', column: 'doing' },
  { id: 'c6', title: 'Set up CI', column: 'done' },
];
const TARGET = { c1: 'done', c2: 'doing' };

const kanban = defineTask({
  id: 'k2-kanban',
  tier: 'k2',
  capability: 'pointer-based drag and drop',
  title: 'Kanban board (pointer drag)',
  answer: { revision: str('the board revision code shown after saving') },
  prompt: () =>
    'On the board, drag the card "Fix login bug" to the Done column and the card "Write docs" to the In Progress column. Leave all other cards where they are. Then click "Save board" and report the revision code shown after saving.',
  routes: {
    'GET /': () =>
      page({
        title: 'Board',
        css: `.board{display:flex;gap:16px}.col{flex:1;background:#eef1f7;border-radius:8px;padding:10px;min-height:340px}
          .kcard{background:#fff;border:1px solid #cdd3e0;border-radius:6px;padding:12px;margin:8px 0;cursor:grab;user-select:none;touch-action:none}
          .ghost{position:fixed;pointer-events:none;opacity:.85;z-index:99;box-shadow:0 8px 20px #0003}.col.hot{outline:3px solid #6b8bd6}`,
        body: `<div style="display:flex;justify-content:space-between;align-items:center"><h1>Product board</h1><button id="save">Save board</button></div>
          <div class="board">${COLUMNS.map((col) => `<div class="col" data-col="${col}"><h2>${COLUMN_TITLES[col]}</h2>${CARDS.filter((card) => card.column === col).map((card) => `<div class="kcard" data-id="${card.id}">${card.title}</div>`).join('')}</div>`).join('')}</div>
          <div id="out" class="result" hidden></div>`,
        script: `let drag = null;
          document.querySelectorAll('.kcard').forEach((card) => {
            card.addEventListener('pointerdown', (event) => {
              const rect = card.getBoundingClientRect();
              const ghost = card.cloneNode(true);
              ghost.classList.add('ghost'); ghost.style.width = rect.width + 'px';
              ghost.style.left = rect.left + 'px'; ghost.style.top = rect.top + 'px';
              document.body.appendChild(ghost);
              drag = { card, ghost, dx: event.clientX - rect.left, dy: event.clientY - rect.top, trusted: event.isTrusted, moved: false };
              card.style.opacity = '.3';
            });
          });
          const columnAt = (x, y) => document.elementsFromPoint(x, y).map((el) => el.closest('.col')).find(Boolean);
          document.addEventListener('pointermove', (event) => {
            if (!drag) return;
            drag.moved = true;
            drag.ghost.style.left = event.clientX - drag.dx + 'px'; drag.ghost.style.top = event.clientY - drag.dy + 'px';
            document.querySelectorAll('.col').forEach((c) => c.classList.remove('hot'));
            const col = columnAt(event.clientX, event.clientY);
            if (col) col.classList.add('hot');
          });
          document.addEventListener('pointerup', (event) => {
            if (!drag) return;
            const col = columnAt(event.clientX, event.clientY);
            if (col && drag.moved && col !== drag.card.parentElement) {
              col.appendChild(drag.card);
              __bench('drag', { trusted: drag.trusted && event.isTrusted, id: drag.card.dataset.id, to: col.dataset.col });
            }
            drag.card.style.opacity = ''; drag.ghost.remove();
            document.querySelectorAll('.col').forEach((c) => c.classList.remove('hot'));
            drag = null;
          });
          document.getElementById('save').onclick = async () => {
            const board = {};
            document.querySelectorAll('.kcard').forEach((card) => (board[card.dataset.id] = card.closest('.col').dataset.col));
            const data = await (await fetch('save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(board) })).json();
            out.hidden = false; out.textContent = 'Board saved. Revision: ' + data.revision;
          };`,
      }),
    'POST /save': (c, req) => {
      const board = req.json();
      c.log('save', board);
      return { json: { revision: `R-${c.code('rev')}` } };
    },
  },
  check: (c, out, events) => {
    const board = serverEvents(events, 'save').at(-1)?.data || {};
    const expected = Object.fromEntries(CARDS.map((card) => [card.id, TARGET[card.id] || card.column]));
    const boardOk = CARDS.every((card) => board[card.id] === expected[card.id]);
    const answer = norm(out?.revision) === `R-${c.code('rev')}`;
    return result(boardOk && answer, { board, expected, answer, got: out?.revision }, { trusted: trustedInput(events, 'drag') });
  },
});

export default [overlays, kanban];
