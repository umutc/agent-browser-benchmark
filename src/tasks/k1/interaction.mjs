import { page, escapeHtml } from '../../lib/html.mjs';
import { defineTask, str, norm, serverEvents, trustedInput, result } from '../common.mjs';

const read = defineTask({
  id: 'k1-read',
  tier: 'k1',
  capability: 'read text',
  title: 'Read text from the page',
  answer: { code: str('the access code') },
  prompt: () => 'Report the access code shown on the page.',
  routes: {
    'GET /': (c) =>
      page({
        title: 'Member Area',
        body: `<div class="card"><h1>Welcome back</h1>
          <p class="muted">Your membership renews on the first of next month.</p>
          <p>Your access code is <strong id="code">${c.code('a')}</strong>.</p>
          <p class="muted">Keep this code private.</p></div>`,
      }),
  },
  check: (c, out) => result(norm(out?.code) === c.code('a'), { expected: c.code('a'), got: out?.code }),
});

const click = defineTask({
  id: 'k1-click',
  tier: 'k1',
  capability: 'click',
  title: 'Click a button',
  answer: { code: str('the revealed code') },
  prompt: () => 'Click the "Reveal code" button and report the code that appears.',
  routes: {
    'GET /': () =>
      page({
        title: 'Reveal',
        body: `<div class="card"><h1>Gift card</h1><p>Your gift card code is hidden.</p>
          <button id="reveal">Reveal code</button><div id="out" class="result" hidden></div></div>`,
        script: `document.getElementById('reveal').addEventListener('click', async (event) => {
          __bench('click', { trusted: event.isTrusted });
          const response = await fetch('reveal', { method: 'POST' });
          const data = await response.json();
          const out = document.getElementById('out');
          out.hidden = false;
          out.textContent = 'Code: ' + data.code;
        });`,
      }),
    'POST /reveal': (c) => {
      c.log('reveal');
      return { json: { code: c.code('r') } };
    },
  },
  check: (c, out, events) =>
    result(norm(out?.code) === c.code('r') && serverEvents(events, 'reveal').length > 0, {
      expected: c.code('r'),
      got: out?.code,
    }, { trusted: trustedInput(events, 'click') }),
});

const phrase = (c) => `alpine ${c.code('p').toLowerCase()} lantern`;

const type = defineTask({
  id: 'k1-type',
  tier: 'k1',
  capability: 'type and submit',
  title: 'Type into a field and submit',
  answer: { confirmation: str('the confirmation code shown after submitting') },
  prompt: (c) =>
    `Type the exact phrase "${phrase(c)}" into the "Phrase" field, submit the form, and report the confirmation code.`,
  routes: {
    'GET /': () =>
      page({
        title: 'Verify Phrase',
        body: `<div class="card"><h1>Verify your phrase</h1>
          <form method="post" action="submit">
            <label for="phrase">Phrase</label>
            <input id="phrase" name="phrase" autocomplete="off" size="40">
            <div style="margin-top:12px"><button type="submit">Submit</button></div>
          </form></div>`,
        script: `let reported = false;
          document.getElementById('phrase').addEventListener('keydown', (event) => {
            if (!reported) { reported = true; __bench('keydown', { trusted: event.isTrusted }); }
          });`,
      }),
    'POST /submit': (c, req) => {
      const submitted = req.form().phrase ?? '';
      c.log('submit', { phrase: submitted });
      const ok = submitted === phrase(c);
      return page({
        title: 'Result',
        body: ok
          ? `<div class="card result"><h1>Verified</h1><p>Confirmation code: <strong>${c.code('c')}</strong></p></div>`
          : `<div class="card"><h1>Phrase did not match</h1><p>You entered: ${escapeHtml(submitted)}</p><a href="./">Try again</a></div>`,
      });
    },
  },
  check: (c, out, events) => {
    const submitted = serverEvents(events, 'submit').some((e) => e.data.phrase === phrase(c));
    return result(submitted && norm(out?.confirmation) === c.code('c'), { submitted, got: out?.confirmation }, {
      trusted: trustedInput(events, 'keydown'),
    });
  },
});

const COUNTRIES = ['Canada', 'Denmark', 'Estonia', 'Finland', 'Iceland', 'Norway', 'Portugal', 'Sweden'];

const controls = defineTask({
  id: 'k1-controls',
  tier: 'k1',
  capability: 'form controls',
  title: 'Select, checkbox, radio and number inputs',
  answer: { receipt: str('the receipt code shown after placing the order') },
  prompt: () =>
    'Fill in the order form: set Country to "Norway", check "Subscribe to newsletter", choose the "Team" plan, set Quantity to 3, then click "Place order". Report the receipt code.',
  routes: {
    'GET /': () =>
      page({
        title: 'Order',
        body: `<div class="card"><h1>Order a plan</h1>
          <form method="post" action="submit">
            <label for="country">Country</label>
            <select id="country" name="country">${COUNTRIES.map((n) => `<option>${n}</option>`).join('')}</select>
            <label><input type="checkbox" name="subscribe" value="yes"> Subscribe to newsletter</label>
            <fieldset style="margin-top:10px"><legend>Plan</legend>
              <label><input type="radio" name="plan" value="basic" checked> Basic</label>
              <label><input type="radio" name="plan" value="pro"> Pro</label>
              <label><input type="radio" name="plan" value="team"> Team</label>
            </fieldset>
            <label for="quantity">Quantity</label>
            <input id="quantity" type="number" name="quantity" min="1" max="10" value="1">
            <div style="margin-top:12px"><button type="submit">Place order</button></div>
          </form></div>`,
      }),
    'POST /submit': (c, req) => {
      const form = req.form();
      c.log('submit', form);
      return page({
        title: 'Receipt',
        body: `<div class="card result"><h1>Order placed</h1><p>Receipt: <strong>${c.code('c')}</strong></p></div>`,
      });
    },
  },
  check: (c, out, events) => {
    const last = serverEvents(events, 'submit').at(-1)?.data || {};
    const fields = {
      country: last.country === 'Norway',
      subscribe: last.subscribe === 'yes',
      plan: last.plan === 'team',
      quantity: last.quantity === '3',
    };
    const pass = Object.values(fields).every(Boolean) && norm(out?.receipt) === c.code('c');
    return result(pass, { fields, submitted: last, got: out?.receipt });
  },
});

const hover = defineTask({
  id: 'k1-hover',
  tier: 'k1',
  capability: 'hover',
  title: 'Hover menu',
  answer: { code: str('the billing code') },
  prompt: () =>
    'Open the "Account" menu in the top navigation by hovering over it, click "Billing", and report the billing code shown on the Billing page.',
  routes: {
    'GET /': () =>
      page({
        title: 'Dashboard',
        css: `.nav{display:flex;gap:24px;background:#fff;border:1px solid #dde1ea;border-radius:8px;padding:10px 16px}
          .menu{position:relative}.menu .items{display:none;position:absolute;top:100%;left:0;background:#fff;border:1px solid #ccd;border-radius:6px;min-width:160px;padding:6px 0;z-index:5}
          .menu:hover .items.ready{display:block}.items a{display:block;padding:6px 14px;color:#243b6b;text-decoration:none}.items a:hover{background:#eef}`,
        body: `<nav class="nav"><span>Home</span><span>Products</span>
          <div class="menu" id="account"><span>Account ▾</span><div class="items" id="items"></div></div></nav>
          <div class="card" style="margin-top:16px"><h1>Dashboard</h1><p>Nothing new today.</p></div>`,
        script: `const account = document.getElementById('account');
          let loaded = false;
          account.addEventListener('mouseenter', async (event) => {
            __bench('hover', { trusted: event.isTrusted });
            if (loaded) return;
            loaded = true;
            const data = await (await fetch('menu', { method: 'POST' })).json();
            const items = document.getElementById('items');
            items.innerHTML = '<a href="profile">Profile</a><a href="billing?t=' + data.token + '">Billing</a><a href="signout">Sign out</a>';
            items.classList.add('ready');
          });`,
      }),
    'POST /menu': (c) => {
      c.log('menu-open');
      return { json: { token: c.code('t', 10) } };
    },
    'GET /billing': (c, req) => {
      const ok = req.query.get('t') === c.code('t', 10);
      if (ok) c.log('billing-view');
      return page({
        title: 'Billing',
        body: ok
          ? `<div class="card"><h1>Billing</h1><p>Billing code: <strong>${c.code('b')}</strong></p></div>`
          : `<div class="card"><h1>Link expired</h1></div>`,
      });
    },
    'GET /profile': () => page({ title: 'Profile', body: '<div class="card"><h1>Profile</h1></div>' }),
    'GET /signout': () => page({ title: 'Signed out', body: '<div class="card"><h1>Signed out</h1></div>' }),
  },
  check: (c, out, events) =>
    result(norm(out?.code) === c.code('b') && serverEvents(events, 'billing-view').length > 0, { got: out?.code }, {
      trusted: trustedInput(events, 'hover'),
    }),
});

const keyboard = defineTask({
  id: 'k1-keyboard',
  tier: 'k1',
  capability: 'keyboard shortcut',
  title: 'Keyboard shortcut',
  answer: { code: str('the code shown in the command palette') },
  prompt: () =>
    'This page has a hidden command palette that opens with the keyboard shortcut Control+Shift+K. Open it and report the code shown in it.',
  routes: {
    'GET /': () =>
      page({
        title: 'Editor',
        css: `#palette{position:fixed;top:20%;left:50%;transform:translateX(-50%);background:#fff;border:2px solid #243b6b;border-radius:10px;padding:24px;min-width:360px;box-shadow:0 10px 30px #0003}`,
        body: `<div class="card"><h1>Document editor</h1><p>Start typing your document here.</p>
          <div contenteditable="true" style="min-height:120px;border:1px dashed #ccd;padding:8px"></div></div>
          <div id="palette" hidden></div>`,
        script: `document.addEventListener('keydown', async (event) => {
          const isK = event.key === 'K' || event.key === 'k' || event.code === 'KeyK';
          if (!(event.ctrlKey && event.shiftKey && isK)) return;
          event.preventDefault();
          __bench('shortcut', { trusted: event.isTrusted });
          const data = await (await fetch('palette', { method: 'POST' })).json();
          const palette = document.getElementById('palette');
          palette.hidden = false;
          palette.innerHTML = '<h2>Command palette</h2><p>Session code: <strong>' + data.code + '</strong></p>';
        });`,
      }),
    'POST /palette': (c) => {
      c.log('palette');
      return { json: { code: c.code('k') } };
    },
  },
  check: (c, out, events) =>
    result(norm(out?.code) === c.code('k') && serverEvents(events, 'palette').length > 0, { got: out?.code }, {
      trusted: trustedInput(events, 'shortcut'),
    }),
});

const dnd = defineTask({
  id: 'k1-dnd',
  tier: 'k1',
  capability: 'drag and drop (HTML5)',
  title: 'HTML5 drag and drop',
  answer: { code: str('the code shown after the drop') },
  prompt: () => 'Drag the card "Task B" from the Backlog column into the Done column. Report the code shown after the drop.',
  routes: {
    'GET /': () =>
      page({
        title: 'Board',
        css: `.cols{display:flex;gap:24px}.col{flex:1;background:#fff;border:1px solid #dde1ea;border-radius:8px;padding:12px;min-height:260px}
          .item{background:#eef2fb;border:1px solid #b9c6e6;border-radius:6px;padding:10px;margin:8px 0;cursor:grab}
          .col.over{outline:3px dashed #243b6b}`,
        body: `<h1>Sprint board</h1><div class="cols">
          <div class="col" id="backlog"><h2>Backlog</h2>
            <div class="item" draggable="true" id="task-a">Task A</div>
            <div class="item" draggable="true" id="task-b">Task B</div>
            <div class="item" draggable="true" id="task-c">Task C</div></div>
          <div class="col" id="done"><h2>Done</h2></div></div>
          <div id="out" class="result" hidden></div>`,
        script: `document.querySelectorAll('.item').forEach((item) => {
            item.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', item.id));
          });
          const done = document.getElementById('done');
          done.addEventListener('dragover', (event) => { event.preventDefault(); done.classList.add('over'); });
          done.addEventListener('dragleave', () => done.classList.remove('over'));
          done.addEventListener('drop', async (event) => {
            event.preventDefault();
            done.classList.remove('over');
            const id = event.dataTransfer.getData('text/plain');
            const item = document.getElementById(id);
            if (!item) return;
            done.appendChild(item);
            __bench('drop', { trusted: event.isTrusted, item: id });
            const data = await (await fetch('drop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: id }) })).json();
            const out = document.getElementById('out');
            out.hidden = false;
            out.textContent = data.message;
          });`,
      }),
    'POST /drop': (c, req) => {
      const { item } = req.json();
      c.log('drop', { item });
      return { json: { message: item === 'task-b' ? `Moved. Code: ${c.code('d')}` : `Moved ${item}. That is not Task B.` } };
    },
  },
  check: (c, out, events) => {
    const dropped = serverEvents(events, 'drop').some((e) => e.data.item === 'task-b');
    return result(dropped && norm(out?.code) === c.code('d'), { dropped, got: out?.code }, {
      trusted: trustedInput(events, 'drop'),
    });
  },
});

export default [read, click, type, controls, hover, keyboard, dnd];
