import { page, escapeHtml } from '../../lib/html.mjs';
import { defineTask, str, num, norm, result } from '../common.mjs';
import { shuffle } from '../../lib/codes.mjs';

const CATEGORIES = ['Tents', 'Backpacks', 'Sleeping Bags', 'Stoves'];
const ADJECTIVES = ['Summit', 'Ridge', 'Alpine', 'Canyon', 'Glacier', 'Timber', 'Harbor', 'Mesa', 'Aurora', 'Cascade', 'Juniper', 'Basalt'];

// 48 products with distinct prices. The target (cheapest in-stock tent rated 4.0+) always
// has two cheaper decoys: an in-stock tent rated 3.9 and a 4.6-rated tent out of stock.
function catalog(c) {
  const cached = c.state.catalog;
  if (cached) return cached;
  const random = c.rng('catalog');
  const prices = shuffle(random, Array.from({ length: 48 }, (_, i) => 4900 + i * 1037 + Math.floor(random() * 900)));
  const names = shuffle(random, ADJECTIVES);
  const products = [];
  for (let i = 0; i < 48; i++) {
    const category = CATEGORIES[i % 4];
    const rating = Math.round((2.5 + random() * 2.5) * 10) / 10;
    products.push({
      sku: `${category.slice(0, 2).toUpperCase()}-${c.code(`sku${i}`, 5)}`,
      name: `${names[i % names.length]} ${category === 'Sleeping Bags' ? 'Sleeping Bag' : category.slice(0, -1)} ${100 + i}`,
      category,
      priceCents: prices[i],
      rating,
      inStock: random() > 0.3,
    });
  }
  const tents = products.filter((p) => p.category === 'Tents').sort((a, b) => a.priceCents - b.priceCents);
  const [decoyLowRating, decoyOutOfStock, target] = tents;
  decoyLowRating.rating = 3.9;
  decoyLowRating.inStock = true;
  decoyOutOfStock.rating = 4.6;
  decoyOutOfStock.inStock = false;
  target.rating = 4.2;
  target.inStock = true;
  c.state.catalog = { products, target };
  return c.state.catalog;
}

const catalogTask = defineTask({
  id: 'k2-catalog',
  tier: 'k2',
  capability: 'SPA filters + async results',
  title: 'Filter a product catalog',
  answer: { sku: str('the SKU of the product'), price: num('its price in dollars') },
  prompt: () =>
    'Using the product catalog, find the cheapest in-stock product in the Tents category with a rating of at least 4.0 stars. Report its SKU and price.',
  routes: {
    'GET /': () =>
      page({
        title: 'Shop',
        css: `.filters{display:flex;gap:16px;flex-wrap:wrap;align-items:end}.filters label{margin:0}
          .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}.p{background:#fff;border:1px solid #dde1ea;border-radius:8px;padding:12px}
          .badge{font-size:12px;padding:2px 6px;border-radius:4px}.in{background:#dcf5e3}.out{background:#fde2e1}.loading{opacity:.4}`,
        body: `<h1>Gear catalog</h1><div class="card filters">
            <div><label for="cat">Category</label><select id="cat"><option value="">All</option>${CATEGORIES.map((x) => `<option>${x}</option>`).join('')}</select></div>
            <div><label for="rating">Minimum rating</label><select id="rating"><option value="0">Any</option><option value="3">3+</option><option value="4">4+</option><option value="4.5">4.5+</option></select></div>
            <div><label><input type="checkbox" id="stock"> In stock only</label></div>
            <div><label for="sort">Sort</label><select id="sort"><option value="featured">Featured</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select></div>
            <button id="apply">Apply filters</button></div>
          <div id="grid" class="grid"></div><div id="pager" style="margin-top:12px;display:flex;gap:6px"></div>`,
        script: `let page = 1;
          async function load() {
            const grid = document.getElementById('grid');
            grid.classList.add('loading');
            const q = new URLSearchParams({ category: cat.value, minRating: rating.value, inStock: stock.checked ? '1' : '', sort: sort.value, page });
            const data = await (await fetch('api/products?' + q)).json();
            await new Promise((r) => setTimeout(r, 700));
            grid.classList.remove('loading');
            grid.innerHTML = data.items.map((p) => '<div class="p"><strong>' + p.name + '</strong><div class="muted">SKU ' + p.sku + '</div><div>$' + (p.priceCents / 100).toFixed(2) + ' · ★ ' + p.rating.toFixed(1) + '</div><span class="badge ' + (p.inStock ? 'in">In stock' : 'out">Out of stock') + '</span></div>').join('') || '<p>No products match.</p>';
            const pager = document.getElementById('pager');
            pager.innerHTML = '';
            for (let i = 1; i <= data.pages; i++) {
              const b = document.createElement('button');
              b.textContent = i; b.className = i === page ? '' : 'secondary';
              b.onclick = () => { page = i; load(); };
              pager.appendChild(b);
            }
          }
          document.getElementById('apply').onclick = () => { page = 1; load(); };
          load();`,
      }),
    'GET /api/products': (c, req) => {
      const { products } = catalog(c);
      const category = req.query.get('category');
      const minRating = Number(req.query.get('minRating') || 0);
      const inStock = req.query.get('inStock') === '1';
      const sort = req.query.get('sort');
      let items = products.filter((p) => (!category || p.category === category) && p.rating >= minRating && (!inStock || p.inStock));
      if (sort === 'price-asc') items = [...items].sort((a, b) => a.priceCents - b.priceCents);
      if (sort === 'price-desc') items = [...items].sort((a, b) => b.priceCents - a.priceCents);
      const pageNumber = Math.max(1, Number(req.query.get('page') || 1));
      c.log('products', { category, minRating, inStock, sort, page: pageNumber });
      return { json: { items: items.slice((pageNumber - 1) * 12, pageNumber * 12), pages: Math.max(1, Math.ceil(items.length / 12)) } };
    },
  },
  check: (c, out) => {
    const { target } = catalog(c);
    const pass = norm(out?.sku) === target.sku && Math.abs(Number(out?.price) - target.priceCents / 100) < 0.01;
    return result(pass, { expected: { sku: target.sku, price: target.priceCents / 100 }, got: out });
  },
});

const CUSTOMERS = ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Wingtip'];
const STATUSES = ['paid', 'overdue', 'pending'];

function invoices(c) {
  if (c.state.invoices) return c.state.invoices;
  const random = c.rng('invoices');
  const rows = Array.from({ length: 95 }, (_, i) => ({
    number: `INV-${String(4100 + i)}`,
    customer: CUSTOMERS[Math.floor(random() * CUSTOMERS.length)],
    amountCents: 5000 + Math.floor(random() * 495000),
    status: STATUSES[Math.floor(random() * STATUSES.length)],
    due: `2026-${String(1 + Math.floor(random() * 9)).padStart(2, '0')}-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`,
  }));
  // Guarantee enough matching rows spread over several pages.
  for (const index of [3, 21, 38, 57, 74, 90]) Object.assign(rows[index], { customer: 'Northwind', status: 'overdue' });
  c.state.invoices = rows;
  return rows;
}

const table = defineTask({
  id: 'k2-table',
  tier: 'k2',
  capability: 'paginated table aggregation',
  title: 'Aggregate a paginated table',
  answer: { total: num('the sum of the matching amounts in dollars'), count: num('how many invoices matched') },
  prompt: () =>
    'The invoice list is split over several pages. Add up the amounts of all invoices for customer "Northwind" whose status is "overdue". Report the total amount and how many invoices matched.',
  routes: {
    'GET /': (c, req) => {
      const rows = invoices(c);
      const pages = Math.ceil(rows.length / 10);
      const current = Math.min(pages, Math.max(1, Number(req.query.get('page') || 1)));
      c.log('page', { page: current });
      const slice = rows.slice((current - 1) * 10, current * 10);
      const links = Array.from({ length: pages }, (_, i) => (i + 1 === current ? `<strong>${i + 1}</strong>` : `<a href="?page=${i + 1}">${i + 1}</a>`)).join(' ');
      return page({
        title: 'Invoices',
        body: `<div class="card"><h1>Invoices</h1><p class="muted">${rows.length} invoices · page ${current} of ${pages}</p>
          <table><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th><th>Due</th></tr>
          ${slice.map((r) => `<tr><td>${r.number}</td><td>${r.customer}</td><td>$${(r.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>${r.status}</td><td>${r.due}</td></tr>`).join('')}
          </table><p style="margin-top:12px">${current > 1 ? `<a href="?page=${current - 1}">‹ Previous</a>` : ''} ${links} ${current < pages ? `<a href="?page=${current + 1}">Next ›</a>` : ''}</p></div>`,
      });
    },
  },
  check: (c, out) => {
    const matches = invoices(c).filter((r) => r.customer === 'Northwind' && r.status === 'overdue');
    const total = matches.reduce((sum, r) => sum + r.amountCents, 0) / 100;
    const pass = Math.abs(Number(out?.total) - total) < 0.01 && Number(out?.count) === matches.length;
    return result(pass, { expected: { total, count: matches.length }, got: out });
  },
});

const BRANDS = ['Lumix', 'Orion', 'Kestrel', 'Vantage', 'Nimbus', 'Halcyon'];
const SENSORS = ['Full frame', 'APS-C', 'Micro Four Thirds', '1-inch'];

function cameras(c) {
  if (c.state.cameras) return c.state.cameras;
  const random = c.rng('cameras');
  const list = Array.from({ length: 12 }, (_, i) => ({
    slug: `cam-${i + 1}`,
    name: `${BRANDS[i % BRANDS.length]} ${String.fromCharCode(65 + i)}${10 + Math.floor(random() * 80)}`,
    year: 2019 + Math.floor(random() * 7),
    weight: 300 + Math.floor(random() * 60) * 10 + i,
    sensor: SENSORS[Math.floor(random() * SENSORS.length)],
    price: 499 + Math.floor(random() * 30) * 50,
  }));
  // Guarantee three matches and two near misses (heavy but new, light but old).
  Object.assign(list[1], { year: 2024, weight: 412 });
  Object.assign(list[5], { year: 2023, weight: 468 });
  Object.assign(list[9], { year: 2025, weight: 377 });
  Object.assign(list[3], { year: 2023, weight: 505 });
  Object.assign(list[7], { year: 2022, weight: 355 });
  for (const [index, camera] of list.entries()) {
    if (![1, 5, 9].includes(index) && camera.year >= 2023 && camera.weight < 500) camera.weight += 200;
  }
  c.state.cameras = list;
  return list;
}

const extract = defineTask({
  id: 'k2-extract',
  tier: 'k2',
  capability: 'multi-page data extraction',
  title: 'Extract data from detail pages',
  answer: {
    cameras: {
      type: 'array',
      description: 'matching cameras, lightest first',
      items: { type: 'object', properties: { name: { type: 'string' }, weightGrams: { type: 'number' } }, required: ['name', 'weightGrams'], additionalProperties: false },
    },
  },
  prompt: () =>
    'The camera list links to a detail page for each camera. Find every camera released in 2023 or later that weighs less than 500 g. Return their names and weights in grams, sorted by weight with the lightest first.',
  routes: {
    'GET /': (c) =>
      page({
        title: 'Cameras',
        body: `<div class="card"><h1>Cameras</h1><ul>${cameras(c).map((cam) => `<li><a href="camera?id=${cam.slug}">${escapeHtml(cam.name)}</a> · ${cam.sensor}</li>`).join('')}</ul></div>`,
      }),
    'GET /camera': (c, req) => {
      const cam = cameras(c).find((x) => x.slug === req.query.get('id'));
      if (!cam) return { status: 404, body: 'not found' };
      c.log('detail', { slug: cam.slug });
      return page({
        title: cam.name,
        body: `<div class="card"><a href="./">‹ All cameras</a><h1>${escapeHtml(cam.name)}</h1><table>
          <tr><th>Sensor</th><td>${cam.sensor}</td></tr><tr><th>Release year</th><td>${cam.year}</td></tr>
          <tr><th>Weight (body only)</th><td>${cam.weight} g</td></tr><tr><th>Launch price</th><td>$${cam.price}</td></tr></table></div>`,
      });
    },
  },
  check: (c, out) => {
    const expected = cameras(c).filter((cam) => cam.year >= 2023 && cam.weight < 500).sort((a, b) => a.weight - b.weight);
    const got = Array.isArray(out?.cameras) ? out.cameras : [];
    const pass =
      got.length === expected.length &&
      expected.every((cam, i) => (got[i]?.name || '').trim().toLowerCase() === cam.name.toLowerCase() && Number(got[i]?.weightGrams) === cam.weight);
    return result(pass, { expected: expected.map((cam) => ({ name: cam.name, weightGrams: cam.weight })), got });
  },
});

export default [catalogTask, table, extract];
