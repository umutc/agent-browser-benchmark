import { page } from '../../lib/html.mjs';
import { defineTask, str, num, norm, serverEvents, result } from '../common.mjs';
import { pick } from '../../lib/codes.mjs';

const PEOPLE = [
  ['Avery Lindqvist', 'avery.lindqvist'],
  ['Jordan Okafor', 'jordan.okafor'],
  ['Riley Marchetti', 'riley.marchetti'],
  ['Morgan Castillo', 'morgan.castillo'],
  ['Quinn Haraldsen', 'quinn.haraldsen'],
];
const ADDRESSES = [
  ['418 Birch Hollow Rd', 'Asheville', 'NC', '28801'],
  ['92 Harbor View Ln', 'Portland', 'ME', '04101'],
  ['1570 Canyon Crest Dr', 'Boulder', 'CO', '80302'],
  ['33 Lakeside Ave', 'Madison', 'WI', '53703'],
];
const STATES = ['AZ', 'CA', 'CO', 'ME', 'MN', 'NC', 'NY', 'OR', 'TX', 'WA', 'WI'];

function customer(c) {
  const random = c.rng('customer');
  const [name, handle] = pick(random, PEOPLE);
  const [street, city, state, zip] = pick(random, ADDRESSES);
  const phoneDigits = `555${String(Math.floor(random() * 9000000) + 1000000)}`;
  return { name, email: `${handle}@example.com`, phoneDigits, street, city, state, zip };
}

const SUBTOTAL_CENTS = 8400;
const EXPRESS_CENTS = 1500;
const TAX_CENTS = Math.round(SUBTOTAL_CENTS * 0.08);
const TOTAL = (SUBTOTAL_CENTS + EXPRESS_CENTS + TAX_CENTS) / 100;

const checkout = defineTask({
  id: 'k2-checkout',
  tier: 'k2',
  capability: 'multi-field form with validation',
  title: 'Checkout form',
  answer: { orderNumber: str('the order number'), total: num('the order total in dollars') },
  prompt: (c) => {
    const p = customer(c);
    const phone = `${p.phoneDigits.slice(0, 3)} ${p.phoneDigits.slice(3, 6)} ${p.phoneDigits.slice(6)}`;
    return `Complete the checkout for this customer and place the order.
Name: ${p.name}
Email: ${p.email}
Phone: ${phone}
Address: ${p.street}, ${p.city}, ${p.state} ${p.zip}
Shipping: Express
Pay by invoice, accept the terms, and place the order. Report the order number and the order total.`;
  },
  routes: {
    'GET /': () =>
      page({
        title: 'Checkout',
        css: `.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}.error{color:#b42318;font-size:14px;min-height:20px}
          .summary td:last-child{text-align:right}`,
        body: `<div style="display:grid;grid-template-columns:2fr 1fr;gap:24px">
          <form class="card" id="form" novalidate><h1>Checkout</h1>
            <h2>Contact</h2>
            <label for="fullName">Full name</label><input id="fullName" name="fullName" size="40"><div class="error" data-for="fullName"></div>
            <div class="grid"><div><label for="email">Email</label><input id="email" name="email" size="30"><div class="error" data-for="email"></div></div>
            <div><label for="phone">Phone</label><input id="phone" name="phone" placeholder="555-555-5555"><div class="error" data-for="phone"></div></div></div>
            <h2>Shipping address</h2>
            <label for="street">Street</label><input id="street" name="street" size="40"><div class="error" data-for="street"></div>
            <div class="grid"><div><label for="city">City</label><input id="city" name="city"><div class="error" data-for="city"></div></div>
            <div><label for="state">State</label><select id="state" name="state"><option value="">Select…</option>${STATES.map((s) => `<option>${s}</option>`).join('')}</select><div class="error" data-for="state"></div></div></div>
            <label for="zip">ZIP code</label><input id="zip" name="zip" size="8"><div class="error" data-for="zip"></div>
            <h2>Shipping method</h2>
            <label><input type="radio" name="shipping" value="standard" checked> Standard (free, 5-7 days)</label>
            <label><input type="radio" name="shipping" value="express"> Express ($15.00, 1-2 days)</label>
            <h2>Payment</h2>
            <label><input type="radio" name="payment" value="card" checked> Credit card (unavailable in test mode)</label>
            <label><input type="radio" name="payment" value="invoice"> Invoice</label>
            <div class="error" data-for="payment"></div>
            <label><input type="checkbox" name="terms" id="terms"> I accept the terms and conditions</label><div class="error" data-for="terms"></div>
            <button type="submit" style="margin-top:12px">Place order</button>
            <div id="done" class="result" hidden></div>
          </form>
          <div class="card summary"><h2>Order summary</h2><table>
            <tr><td>Trail Lantern ×2</td><td>$68.00</td></tr><tr><td>Camp Mug ×1</td><td>$16.00</td></tr>
            <tr><td>Subtotal</td><td>$84.00</td></tr><tr><td>Shipping</td><td id="ship">$0.00</td></tr>
            <tr><td>Tax (8%)</td><td>$6.72</td></tr><tr><th>Total</th><th id="total">$90.72</th></tr></table></div></div>`,
        script: `const form = document.getElementById('form');
          const phone = document.getElementById('phone');
          phone.addEventListener('input', () => {
            const d = phone.value.replace(/\\D/g, '').slice(0, 10);
            phone.value = d.length > 6 ? d.slice(0,3) + '-' + d.slice(3,6) + '-' + d.slice(6) : d.length > 3 ? d.slice(0,3) + '-' + d.slice(3) : d;
          });
          form.addEventListener('change', () => {
            const express = form.shipping.value === 'express';
            document.getElementById('ship').textContent = express ? '$15.00' : '$0.00';
            document.getElementById('total').textContent = express ? '$105.72' : '$90.72';
          });
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const v = Object.fromEntries(new FormData(form));
            v.terms = document.getElementById('terms').checked;
            const errors = {};
            if (!v.fullName.trim()) errors.fullName = 'Enter your name.';
            if (!/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(v.email)) errors.email = 'Enter a valid email address.';
            if (!/^\\d{3}-\\d{3}-\\d{4}$/.test(v.phone)) errors.phone = 'Use the format 555-555-5555.';
            if (!v.street.trim()) errors.street = 'Enter a street address.';
            if (!v.city.trim()) errors.city = 'Enter a city.';
            if (!v.state) errors.state = 'Select a state.';
            if (!/^\\d{5}$/.test(v.zip)) errors.zip = 'ZIP code must be 5 digits.';
            if (v.payment !== 'invoice') errors.payment = 'Card payments are unavailable in test mode. Choose Invoice.';
            if (!v.terms) errors.terms = 'You must accept the terms.';
            document.querySelectorAll('.error').forEach((el) => (el.textContent = errors[el.dataset.for] || ''));
            if (Object.keys(errors).length) return;
            const data = await (await fetch('order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) })).json();
            const done = document.getElementById('done');
            done.hidden = false;
            done.innerHTML = '<strong>Thank you!</strong> Order number: ' + data.orderNumber + ' · Total charged: $' + data.total.toFixed(2);
          });`,
      }),
    'POST /order': (c, req) => {
      const order = req.json();
      c.log('order', order);
      const total = (SUBTOTAL_CENTS + (order.shipping === 'express' ? EXPRESS_CENTS : 0) + TAX_CENTS) / 100;
      return { json: { orderNumber: `AO-${c.digits('order', 6)}`, total } };
    },
  },
  check: (c, out, events) => {
    const p = customer(c);
    const order = serverEvents(events, 'order').at(-1)?.data || {};
    const fields = {
      name: (order.fullName || '').trim().toLowerCase() === p.name.toLowerCase(),
      email: (order.email || '').trim().toLowerCase() === p.email,
      phone: (order.phone || '').replace(/\D/g, '') === p.phoneDigits,
      street: (order.street || '').trim().toLowerCase() === p.street.toLowerCase(),
      city: (order.city || '').trim().toLowerCase() === p.city.toLowerCase(),
      state: order.state === p.state,
      zip: order.zip === p.zip,
      shipping: order.shipping === 'express',
      payment: order.payment === 'invoice',
      terms: order.terms === true,
    };
    const answer = norm(out?.orderNumber) === `AO-${c.digits('order', 6)}` && Math.abs(Number(out?.total) - TOTAL) < 0.01;
    return result(Object.values(fields).every(Boolean) && answer, { fields, answer, got: out });
  },
});

const WIZARD_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function wizardProfile(c) {
  const random = c.rng('wizard');
  return {
    year: String(2012 + Math.floor(random() * 12)),
    birthYear: 1968 + Math.floor(random() * 30),
    birthMonth: Math.floor(random() * 12),
    birthDay: 1 + Math.floor(random() * 28),
    experience: String(2 + Math.floor(random() * 15)),
  };
}

const iso = (year, month, day) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const wizard = defineTask({
  id: 'k2-wizard',
  tier: 'k2',
  capability: 'multi-step wizard + custom date picker',
  title: 'Quote wizard',
  answer: { reference: str('the quote reference') },
  prompt: (c) => {
    const p = wizardProfile(c);
    return `Request an insurance quote with these details:
Vehicle type: Motorcycle, model year ${p.year}
Driver: Jordan Reyes, date of birth ${p.birthDay} ${WIZARD_MONTHS[p.birthMonth]} ${p.birthYear}
Always wears a helmet: Yes
Riding experience: ${p.experience} years
Go through every step, submit the request, and report the quote reference.`;
  },
  routes: {
    'GET /': () =>
      page({
        title: 'Get a Quote',
        css: `.steps{display:flex;gap:8px;margin-bottom:16px}.steps span{padding:4px 10px;border-radius:12px;background:#e3e6ee}.steps span.on{background:#243b6b;color:#fff}
          .step{display:none}.step.on{display:block}.err{color:#b42318;min-height:20px}
          .picker{position:relative;display:inline-block}.cal{position:absolute;top:110%;left:0;background:#fff;border:1px solid #99a;border-radius:8px;padding:10px;z-index:10;width:300px;box-shadow:0 6px 20px #0002}
          .cal .head{display:flex;justify-content:space-between;align-items:center;gap:6px}.cal .days{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-top:8px}
          .cal .days button{padding:4px 0;background:#f2f4f8;color:#1d2330;border:1px solid #dde}.cal .days button:hover{background:#dbe4ff}`,
        body: `<div class="card"><h1>Get a quote</h1>
          <div class="steps"><span data-s="1" class="on">1 Vehicle</span><span data-s="2">2 Driver</span><span data-s="3">3 Details</span><span data-s="4">4 Review</span></div>
          <section class="step on" data-step="1"><h2>Your vehicle</h2>
            <label><input type="radio" name="vehicle" value="car"> Car</label>
            <label><input type="radio" name="vehicle" value="motorcycle"> Motorcycle</label>
            <label><input type="radio" name="vehicle" value="rv"> RV</label>
            <label for="year">Model year</label><select id="year"><option value="">Select…</option>${Array.from({ length: 27 }, (_, i) => `<option>${2026 - i}</option>`).join('')}</select></section>
          <section class="step" data-step="2"><h2>Driver</h2>
            <label for="first">First name</label><input id="first"><label for="last">Last name</label><input id="last">
            <label for="dob">Date of birth</label><div class="picker"><input id="dob" readonly placeholder="Pick a date" style="cursor:pointer"><div class="cal" id="cal" hidden></div></div></section>
          <section class="step" data-step="3"><h2>Details</h2><div id="details"></div></section>
          <section class="step" data-step="4"><h2>Review</h2><div id="review"></div></section>
          <p class="err" id="err"></p>
          <button class="secondary" id="back" hidden>Back</button> <button id="next">Next</button> <button id="submit" hidden>Submit quote request</button>
          <div id="done" class="result" hidden></div></div>`,
        script: `const MONTHS = ${JSON.stringify(WIZARD_MONTHS)};
          const state = { step: 1, dob: null };
          const $ = (id) => document.getElementById(id);
          function show() {
            document.querySelectorAll('.step').forEach((s) => s.classList.toggle('on', Number(s.dataset.step) === state.step));
            document.querySelectorAll('.steps span').forEach((s) => s.classList.toggle('on', Number(s.dataset.s) === state.step));
            $('back').hidden = state.step === 1; $('next').hidden = state.step === 4; $('submit').hidden = state.step !== 4; $('err').textContent = '';
          }
          function vehicle() { return (document.querySelector('input[name=vehicle]:checked') || {}).value; }
          function renderDetails() {
            $('details').innerHTML = vehicle() === 'motorcycle'
              ? '<p>Do you always wear a helmet?</p><label><input type="radio" name="helmet" value="yes"> Yes</label><label><input type="radio" name="helmet" value="no"> No</label><label for="exp">Riding experience (years)</label><input id="exp" type="number" min="0" max="60">'
              : '<label for="miles">Annual mileage</label><select id="miles"><option value="">Select…</option><option>Under 5,000</option><option>5,000-10,000</option><option>Over 10,000</option></select>';
          }
          function values() {
            return { vehicle: vehicle(), year: $('year').value, first: $('first').value.trim(), last: $('last').value.trim(), dob: state.dob,
              helmet: (document.querySelector('input[name=helmet]:checked') || {}).value, experience: $('exp') ? $('exp').value : null, miles: $('miles') ? $('miles').value : null };
          }
          function validate() {
            const v = values();
            if (state.step === 1 && (!v.vehicle || !v.year)) return 'Choose a vehicle type and model year.';
            if (state.step === 2 && (!v.first || !v.last || !v.dob)) return 'Enter the driver name and date of birth.';
            if (state.step === 3 && v.vehicle === 'motorcycle' && (!v.helmet || v.experience === '')) return 'Answer both questions.';
            if (state.step === 3 && v.vehicle !== 'motorcycle' && !v.miles) return 'Choose the annual mileage.';
            return '';
          }
          $('next').onclick = () => {
            const error = validate();
            if (error) { $('err').textContent = error; return; }
            if (state.step === 1) renderDetails();
            state.step += 1;
            if (state.step === 4) { const v = values(); $('review').innerHTML = '<pre>' + JSON.stringify(v, null, 2) + '</pre>'; }
            show();
          };
          $('back').onclick = () => { state.step -= 1; show(); };
          $('submit').onclick = async () => {
            const data = await (await fetch('quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values()) })).json();
            $('done').hidden = false; $('done').textContent = 'Quote requested. Reference: ' + data.reference;
          };
          let view = { y: 2000, m: 0 };
          function renderCal() {
            const cal = $('cal');
            const years = Array.from({ length: 90 }, (_, i) => 2026 - i).map((y) => '<option' + (y === view.y ? ' selected' : '') + '>' + y + '</option>').join('');
            const first = new Date(view.y, view.m, 1).getDay();
            const count = new Date(view.y, view.m + 1, 0).getDate();
            let days = '';
            for (let i = 0; i < first; i++) days += '<span></span>';
            for (let d = 1; d <= count; d++) days += '<button type="button" data-d="' + d + '">' + d + '</button>';
            cal.innerHTML = '<div class="head"><button type="button" id="prev">‹</button><strong>' + MONTHS[view.m] + '</strong><select id="cy">' + years + '</select><button type="button" id="nextm">›</button></div><div class="days">' + days + '</div>';
            $('prev').onclick = () => { view.m -= 1; if (view.m < 0) { view.m = 11; view.y -= 1; } renderCal(); };
            $('nextm').onclick = () => { view.m += 1; if (view.m > 11) { view.m = 0; view.y += 1; } renderCal(); };
            $('cy').onchange = (e) => { view.y = Number(e.target.value); renderCal(); };
            cal.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => {
              const d = Number(b.dataset.d);
              state.dob = view.y + '-' + String(view.m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
              $('dob').value = d + ' ' + MONTHS[view.m] + ' ' + view.y;
              cal.hidden = true;
            }));
          }
          $('dob').onclick = () => { const cal = $('cal'); cal.hidden = !cal.hidden; if (!cal.hidden) renderCal(); };`,
      }),
    'POST /quote': (c, req) => {
      const body = req.json();
      c.log('quote', body);
      return { json: { reference: `Q-${c.code('q')}` } };
    },
  },
  check: (c, out, events) => {
    const p = wizardProfile(c);
    const quote = serverEvents(events, 'quote').at(-1)?.data || {};
    const fields = {
      vehicle: quote.vehicle === 'motorcycle',
      year: quote.year === p.year,
      name: (quote.first || '').toLowerCase() === 'jordan' && (quote.last || '').toLowerCase() === 'reyes',
      dob: quote.dob === iso(p.birthYear, p.birthMonth, p.birthDay),
      helmet: quote.helmet === 'yes',
      experience: String(quote.experience) === p.experience,
    };
    const answer = norm(out?.reference) === `Q-${c.code('q')}`;
    return result(Object.values(fields).every(Boolean) && answer, { fields, answer, got: out?.reference, submitted: quote });
  },
});

const USERNAME = 'casey.tester';
const password = (c) => `Trail-${c.code('pw', 6)}`;

function stage(c, req) {
  const cookie = req.cookies.bench_auth;
  if (cookie === c.code('full', 12)) return 'full';
  if (cookie === c.code('half', 12)) return 'half';
  return 'none';
}

const login = defineTask({
  id: 'k2-login',
  tier: 'k2',
  capability: 'login + 2FA across tabs + settings',
  title: 'Login with two-step verification',
  answer: { accountId: str('the Account ID shown in Settings') },
  prompt: (c) =>
    `Log in with username "${USERNAME}" and password "${password(c)}". Complete the two-step verification: the code is sent to the inbox page linked from the verification screen; use the newest message. Then open Settings, turn OFF email notifications, save, and report the Account ID shown in Settings.`,
  routes: {
    'GET /': () =>
      page({
        title: 'Sign in',
        body: `<form class="card" method="post" action="login" style="max-width:420px"><h1>Sign in</h1>
          <label for="u">Username</label><input id="u" name="username" autocomplete="off">
          <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="off">
          <div style="margin-top:12px"><button type="submit">Sign in</button></div></form>`,
      }),
    'POST /login': (c, req) => {
      const { username, password: given } = req.form();
      const ok = username === USERNAME && given === password(c);
      c.log('login', { ok });
      if (!ok) return page({ title: 'Sign in', body: '<div class="card"><h1>Wrong username or password</h1><a href="./">Try again</a></div>' });
      return { redirect: 'verify', headers: { 'set-cookie': `bench_auth=${c.code('half', 12)}; Path=/; HttpOnly` } };
    },
    'GET /verify': (c, req) =>
      stage(c, req) === 'none'
        ? { redirect: './' }
        : page({
            title: 'Verify',
            body: `<form class="card" method="post" action="verify" style="max-width:480px"><h1>Two-step verification</h1>
              <p>We sent a 6-digit code to your inbox. <a href="inbox" target="_blank">Open your inbox</a> (opens in a new tab).</p>
              <label for="code">Verification code</label><input id="code" name="code" inputmode="numeric" autocomplete="off">
              <div style="margin-top:12px"><button type="submit">Verify</button></div></form>`,
          }),
    'GET /inbox': (c, req) =>
      stage(c, req) === 'none'
        ? page({ title: 'Inbox', body: '<div class="card"><h1>Sign in first</h1></div>' })
        : page({
            title: 'Inbox',
            body: `<div class="card"><h1>Inbox</h1><table><tr><th>Received</th><th>Subject</th><th>Message</th></tr>
              <tr><td>Just now</td><td>Your sign-in code</td><td>Your verification code is <strong>${c.digits('otp')}</strong>. It expires in 10 minutes.</td></tr>
              <tr><td>2 hours ago</td><td>Your sign-in code</td><td>Your verification code is <strong>${c.digits('old1')}</strong>. It expires in 10 minutes.</td></tr>
              <tr><td>Yesterday</td><td>Your sign-in code</td><td>Your verification code is <strong>${c.digits('old2')}</strong>. It expires in 10 minutes.</td></tr>
              </table></div>`,
          }),
    'POST /verify': (c, req) => {
      if (stage(c, req) === 'none') return { redirect: './' };
      const ok = (req.form().code || '').trim() === c.digits('otp');
      c.log('verify', { ok });
      if (!ok) return page({ title: 'Verify', body: '<div class="card"><h1>That code is not valid</h1><a href="verify">Try again</a></div>' });
      return { redirect: 'app', headers: { 'set-cookie': `bench_auth=${c.code('full', 12)}; Path=/; HttpOnly` } };
    },
    'GET /app': (c, req) =>
      stage(c, req) !== 'full'
        ? { redirect: './' }
        : page({
            title: 'Dashboard',
            body: `<nav class="card"><a href="app">Dashboard</a> · <a href="settings">Settings</a></nav><div class="card"><h1>Dashboard</h1><p>Welcome back, Casey.</p></div>`,
          }),
    'GET /settings': (c, req) => {
      if (stage(c, req) !== 'full') return { redirect: './' };
      const saved = c.state.settings || { email: true, sms: false };
      return page({
        title: 'Settings',
        body: `<nav class="card"><a href="app">Dashboard</a> · <a href="settings">Settings</a></nav>
          <form class="card" method="post" action="settings"><h1>Settings</h1>
          <p>Account ID: <strong>${c.code('acct', 8)}</strong></p>
          <label><input type="checkbox" name="email" ${saved.email ? 'checked' : ''}> Email notifications</label>
          <label><input type="checkbox" name="sms" ${saved.sms ? 'checked' : ''}> SMS notifications</label>
          <button type="submit" style="margin-top:12px">Save</button>${c.state.savedOnce ? '<p class="result">Settings saved.</p>' : ''}</form>`,
      });
    },
    'POST /settings': (c, req) => {
      if (stage(c, req) !== 'full') return { redirect: './' };
      const form = req.form();
      c.state.settings = { email: form.email === 'on', sms: form.sms === 'on' };
      c.state.savedOnce = true;
      c.log('settings', c.state.settings);
      return { redirect: 'settings' };
    },
  },
  check: (c, out, events) => {
    const last = serverEvents(events, 'settings').at(-1)?.data;
    const settingsOk = last?.email === false && last?.sms === false;
    const answer = norm(out?.accountId) === c.code('acct', 8);
    return result(settingsOk && answer, { settings: last ?? null, answer, got: out?.accountId });
  },
});

export default [checkout, wizard, login];
