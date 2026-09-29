#!/usr/bin/env node
// Reference solutions for K2 and fixture checks for K3, driven directly with Playwright
// (no agent). A task that fails here is a fixture bug, not an agent failure.
//   BENCH_PORT=8799 node src/selfcheck.mjs --engine chromium|webkit [--only k2-wizard]
import { parseArgs } from 'node:util';
import { startServer, makeContext, runEvents, PORT } from './server.mjs';
import { TASKS } from './tasks/index.mjs';
import { newRunId } from './lib/codes.mjs';

const PLAYWRIGHT_CORE = '/Users/umutc/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
const { chromium, webkit } = await import(PLAYWRIGHT_CORE);
const { values: options } = parseArgs({ options: { engine: { type: 'string', default: 'chromium' }, only: { type: 'string' } } });

async function textMatching(page, selector, pattern) {
  const locator = page.locator(selector);
  await locator.filter({ hasText: pattern }).first().waitFor({ timeout: 10000 });
  return (await locator.innerText()).match(pattern);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const SOLVERS = {
  async 'k2-checkout'(page, c, prompt) {
    const get = (label) => prompt.match(new RegExp(`${label}: (.+)`))[1].trim();
    const [street, city, stateZip] = get('Address').split(', ');
    const [state, zip] = stateZip.split(' ');
    await page.fill('#fullName', get('Name'));
    await page.fill('#email', get('Email'));
    await page.locator('#phone').pressSequentially(get('Phone'));
    await page.fill('#street', street);
    await page.fill('#city', city);
    await page.selectOption('#state', state);
    await page.fill('#zip', zip);
    await page.check('input[value=express]');
    await page.check('input[value=invoice]');
    await page.check('#terms');
    await page.click('button[type=submit]');
    const [, orderNumber, total] = await textMatching(page, '#done', /Order number: (\S+) · Total charged: \$([\d.]+)/);
    return { orderNumber, total: Number(total) };
  },
  async 'k2-wizard'(page, c, prompt) {
    const year = prompt.match(/model year (\d+)/)[1];
    const [, day, month, birthYear] = prompt.match(/date of birth (\d+) (\w+) (\d+)/);
    const experience = prompt.match(/Riding experience: (\d+)/)[1];
    await page.check('input[value=motorcycle]');
    await page.selectOption('#year', year);
    await page.click('#next');
    await page.fill('#first', 'Jordan');
    await page.fill('#last', 'Reyes');
    await page.click('#dob');
    await page.selectOption('#cy', birthYear);
    const target = MONTHS.indexOf(month);
    for (let guard = 0; guard < 24; guard++) {
      const shown = MONTHS.indexOf(await page.locator('#cal .head strong').innerText());
      if (shown === target) break;
      await page.click(shown < target ? '#nextm' : '#prev');
    }
    await page.click(`#cal [data-d="${day}"]`);
    await page.click('#next');
    await page.check('input[name=helmet][value=yes]');
    await page.fill('#exp', experience);
    await page.click('#next');
    await page.click('#submit');
    return { reference: (await textMatching(page, '#done', /Reference: (\S+)/))[1] };
  },
  async 'k2-login'(page, c, prompt) {
    const [, username, password] = prompt.match(/username "([^"]+)" and password "([^"]+)"/);
    await page.fill('#u', username);
    await page.fill('#p', password);
    await page.click('button[type=submit]');
    const [inbox] = await Promise.all([page.context().waitForEvent('page'), page.click('text=Open your inbox')]);
    await inbox.waitForLoadState();
    const code = await inbox.locator('tr:nth-child(2) strong').innerText();
    await inbox.close();
    await page.fill('#code', code);
    await page.click('button[type=submit]');
    await page.click('text=Settings');
    await page.uncheck('input[name=email]');
    await page.click('button[type=submit]');
    return { accountId: (await page.locator('text=Account ID').innerText()).split(':')[1].trim() };
  },
  async 'k2-catalog'(page) {
    await page.selectOption('#cat', 'Tents');
    await page.selectOption('#rating', '4');
    await page.check('#stock');
    await page.selectOption('#sort', 'price-asc');
    await page.click('#apply');
    await page.waitForTimeout(1500);
    const first = page.locator('#grid .p').first();
    const text = await first.innerText();
    return { sku: text.match(/SKU (\S+)/)[1], price: Number(text.match(/\$([\d.]+)/)[1]) };
  },
  async 'k2-table'(page) {
    let total = 0;
    let count = 0;
    for (let p = 1; p <= 10; p++) {
      await page.goto(`${page.url().split('?')[0]}?page=${p}`);
      for (const row of await page.locator('table tr').all()) {
        const cells = await row.locator('td').allInnerTexts();
        if (cells[1] === 'Northwind' && cells[3] === 'overdue') {
          total += Number(cells[2].replace(/[$,]/g, ''));
          count += 1;
        }
      }
    }
    return { total: Math.round(total * 100) / 100, count };
  },
  async 'k2-extract'(page) {
    const links = await page.locator('li a').evaluateAll((as) => as.map((a) => a.href));
    const found = [];
    for (const href of links) {
      await page.goto(href);
      const name = await page.locator('h1').innerText();
      const year = Number(await page.locator('tr:has-text("Release year") td').innerText());
      const weight = parseInt(await page.locator('tr:has-text("Weight") td').innerText(), 10);
      if (year >= 2023 && weight < 500) found.push({ name, weightGrams: weight });
    }
    return { cameras: found.sort((a, b) => a.weightGrams - b.weightGrams) };
  },
  async 'k2-overlays'(page, c, prompt) {
    const coupon = prompt.match(/coupon code (\S+),/)[1];
    await page.click('#reject');
    const add = async (name, qty) => {
      const card = page.locator('[data-sku]', { hasText: name });
      for (let i = 1; i < qty; i++) await card.locator('[data-act=inc]').click();
      await card.locator('[data-act=add]').click();
      await page.waitForTimeout(300);
    };
    await add('Trail Lantern', 2);
    await page.locator('#nothanks').click({ timeout: 8000 });
    await add('Camp Mug', 1);
    await page.click('text=Cart (');
    await page.fill('#coupon', coupon);
    await page.click('text=Apply');
    const total = await page.locator('tr:has-text("Grand total") th').last().innerText();
    return { total: Number(total.replace('$', '')) };
  },
  async 'k2-kanban'(page) {
    const dragTo = async (title, column) => {
      const card = page.locator('.kcard', { hasText: title }).first();
      const target = page.locator(`.col[data-col=${column}]`);
      const from = await card.boundingBox();
      const to = await target.boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height - 40, { steps: 12 });
      await page.mouse.up();
    };
    await dragTo('Fix login bug', 'done');
    await dragTo('Write docs', 'doing');
    await page.click('#save');
    return { revision: (await textMatching(page, '#out', /Revision: (\S+)/))[1] };
  },
};


const K1_SOLVERS = {
  async 'k1-read'(page) {
    return { code: await page.locator('#code').innerText() };
  },
  async 'k1-click'(page) {
    await page.click('#reveal');
    return { code: (await textMatching(page, '#out', /Code: (\S+)/))[1] };
  },
  async 'k1-type'(page, c, prompt) {
    await page.locator('#phrase').pressSequentially(prompt.match(/phrase "([^"]+)"/)[1]);
    await page.click('button[type=submit]');
    return { confirmation: (await textMatching(page, 'strong', /(\S+)/))[1] };
  },
  async 'k1-controls'(page) {
    await page.selectOption('#country', 'Norway');
    await page.check('input[name=subscribe]');
    await page.check('input[value=team]');
    await page.fill('#quantity', '3');
    await page.click('button[type=submit]');
    return { receipt: (await textMatching(page, 'strong', /(\S+)/))[1] };
  },
  async 'k1-hover'(page) {
    await page.hover('#account');
    await page.click('text=Billing');
    return { code: (await textMatching(page, 'strong', /(\S+)/))[1] };
  },
  async 'k1-keyboard'(page) {
    await page.keyboard.press('Control+Shift+K');
    return { code: (await textMatching(page, '#palette', /Session code: (\S+)/))[1] };
  },
  async 'k1-dnd'(page) {
    await page.dragAndDrop('#task-b', '#done');
    return { code: (await textMatching(page, '#out', /Code: (\S+)/))[1] };
  },
  async 'k1-iframe'(page) {
    const frame = page.frameLocator('iframe');
    await frame.locator('#get').click();
    await frame.locator('#out').filter({ hasText: 'Voucher' }).waitFor();
    return { voucher: (await frame.locator('#out').innerText()).split(': ')[1] };
  },
  async 'k1-iframe-xo'(page) {
    return K1_SOLVERS['k1-iframe'](page);
  },
  async 'k1-shadow'(page, c, prompt) {
    await page.locator('acme-coupon input').fill(prompt.match(/type (\S+) into/)[1]);
    await page.locator('acme-coupon button').click();
    await page.locator('acme-coupon .msg').filter({ hasText: 'Confirmation' }).waitFor();
    return { code: (await page.locator('acme-coupon .msg').innerText()).split(': ')[1] };
  },
  async 'k1-popup'(page) {
    await page.waitForTimeout(300);
    const [popup] = await Promise.all([page.context().waitForEvent('page'), page.click('#open')]);
    await popup.waitForLoadState();
    const code = await popup.locator('strong').innerText();
    await popup.close();
    return { receipt: code };
  },
  async 'k1-scroll'(page) {
    for (let i = 0; i < 30; i++) {
      if ((await page.locator('.row', { hasText: 'Item #87 ' }).count()) > 0) break;
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(600);
    }
    return { reference: (await page.locator('.row', { hasText: 'Item #87 ' }).innerText()).split('reference ')[1] };
  },
  async 'k1-dialogs'(page) {
    await page.waitForTimeout(300);
    page.on('dialog', (dialog) => dialog.type() === 'prompt' ? dialog.accept(dialog.message().match(/Type (\S+)/)[1]) : dialog.accept());
    await page.click('#del');
    return { code: (await textMatching(page, '#out', /Code: (\S+)/))[1] };
  },
  async 'k1-upload'(page, c, prompt) {
    await page.setInputFiles('#file', prompt.match(/file at (\S+) using/)[1]);
    await page.click('button[type=submit]');
    return { receipt: (await textMatching(page, 'strong', /(\S+)/))[1] };
  },
  async 'k1-download'(page) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Download report')]);
    const { readFileSync } = await import('node:fs');
    return { code: readFileSync(await download.path(), 'utf8').match(/report-code: (\S+)/)[1] };
  },
  async 'k1-cookie'(page) {
    const cookies = await page.context().cookies();
    return { value: cookies.find((x) => x.name === 'bench_session').value };
  },
  async 'k1-console'(page, c, prompt, extra) {
    await page.reload();
    await page.waitForTimeout(800);
    return { token: extra.consoleErrors.map((t) => t.match(/token (\S+)/)?.[1]).find(Boolean) };
  },
  async 'k1-network'(page, c, prompt, extra) {
    await page.waitForTimeout(800);
    return { syncId: JSON.parse(extra.syncBodies[0]).syncId };
  },
  async 'k1-eval'(page, c, prompt) {
    return { value: await page.evaluate((arg) => window.acmeChecksum(arg), prompt.match(/argument "([^"]+)"/)[1]) };
  },
  async 'k1-responsive'(page) {
    await page.setViewportSize({ width: 400, height: 800 });
    return { code: (await textMatching(page, '#out', /code: (\S+)/))[1] };
  },
  async 'k1-print'(page) {
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(600);
    const text = await page.locator('#out').textContent();
    await page.emulateMedia({ media: 'screen' });
    return { code: text.match(/code: (\S+)/)[1] };
  },
};

// K3: confirm the seeded bugs really show up in the browser, then answer from the truth.
const K3_CHECKS = {
  async 'k3-network'(page, c, task) {
    await page.waitForTimeout(1200);
    return task.check(c, {}, runEvents(c.runId)).details.truth;
  },
  async 'k3-console'(page, c, task, errors) {
    for (const b of await page.locator('button[data-l]').all()) {
      await b.click();
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1500);
    const truth = task.check(c, {}, []).details.truth;
    const expected = Object.values(truth).filter((v) => v !== 'ok').length;
    if (errors.length !== expected) throw new Error(`expected ${expected} page errors, saw ${errors.length}: ${errors.join(' | ')}`);
    return truth;
  },
  async 'k3-a11y'(page, c, task) {
    return task.check(c, {}, []).details.truth;
  },
  async 'k3-responsive'(page, c, task) {
    const truth = task.check(c, {}, []).details.truth;
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(400);
    const measured = await page.$$eval('section', (sections) =>
      sections.map((s) => {
        const inner = s.querySelector('div,p');
        return { letter: s.querySelector('h2').textContent.slice(-1), overflow: s.scrollWidth > s.clientWidth + 1 || inner.scrollWidth > inner.clientWidth + 1 };
      }),
    );
    for (const m of measured) {
      if ((truth[m.letter] !== 'ok') !== m.overflow) throw new Error(`section ${m.letter}: truth ${truth[m.letter]} but overflow=${m.overflow}`);
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    return truth;
  },
  async 'k3-engine'(page, c, task) {
    await page.waitForTimeout(800);
    const scored = task.check(c, {}, runEvents(c.runId));
    if (!scored.details.reported) throw new Error('page did not report section results');
    return scored.details.truth;
  },
};

const server = await startServer(TASKS);
const browserType = options.engine === 'webkit' ? webkit : chromium;
const browser = await browserType.launch({ headless: false, ...(options.engine === 'chromium' ? { channel: 'chrome' } : {}) });
let failures = 0;
for (const task of TASKS.filter((t) => (K1_SOLVERS[t.id] || ['k2', 'k3'].includes(t.tier)) && (!options.only || t.id === options.only))) {
  const runId = newRunId();
  const c = makeContext(runId, task.id);
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  const extra = { consoleErrors: [], syncBodies: [] };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && extra.consoleErrors.push(m.text()));
  page.on('request', (r) => r.url().endsWith('/sync') && extra.syncBodies.push(r.postData()));
  const env = { workdir: '/tmp' };
  task.prepare?.(c, env);
  context.on('page', (p) => p.on('pageerror', (error) => errors.push(error.message)));
  try {
    await page.goto(c.url('/').replace('localhost:', 'localhost:'), { waitUntil: 'load' });
    await page.waitForTimeout(500);
    let answer;
    const solver = SOLVERS[task.id] || K1_SOLVERS[task.id];
    if (solver) {
      const prompt = task.prompt(c, env);
      answer = { completed: true, notes: 'reference', ...(await solver(page, c, prompt, extra)) };
      if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
    } else {
      answer = { completed: true, notes: 'reference', ...(await K3_CHECKS[task.id](page, c, task, errors)) };
    }
    const verdict = task.check(c, answer, runEvents(runId));
    if (!verdict.pass) failures += 1;
    console.log(`${verdict.pass ? 'PASS' : 'FAIL'} ${task.id} ${verdict.pass ? '' : JSON.stringify(verdict.details).slice(0, 400)}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${task.id} ${String(error.message).split('\n')[0].slice(0, 300)}`);
    const visible = await page.evaluate(() => [...document.querySelectorAll('.error,.err,#err,#done,#out,.result')].map((e) => `${e.id || e.className}=${e.innerText}`).filter((t) => !t.endsWith('=')).join(' | ')).catch(() => '');
    console.log(`     visible: ${visible.slice(0, 400)} | pageErrors: ${errors.join(' | ').slice(0, 300)}`);
    await page.screenshot({ path: `/tmp/selfcheck-${task.id}.png` }).catch(() => {});
  }
  await context.close();
}
await browser.close();
server.close();
console.log(`${options.engine}: ${failures ? `${failures} failures` : 'all reference solutions pass'} (port ${PORT})`);
process.exit(failures ? 1 : 0);
