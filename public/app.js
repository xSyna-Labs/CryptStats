// CryptStats – Client. Kein Build-Schritt, nur Browser-JavaScript.

const UNIT = 'Coins';
const REFRESH_MS = 30000;
const DAY = 86400000;
const RANGES = [
  ['1T', 1],
  ['1W', 7],
  ['1M', 30],
  ['1J', 365],
  ['MAX', null],
];
const UP = '#16c784';
const DOWN = '#ea3943';
const ROLE_LABELS = { root: 'Root', admin: 'Admin', viewer: 'Lesend' };

const state = {
  token: 0,
  refresh: null,
  market: null,
  sort: { key: 'symbol', dir: 1 },
  filter: '',
  range: '1M',
  stock: null,
  stockSlug: null,
  user: null,
  setupRequired: false,
  admin: { stockEditId: null, eventEditId: null, eventStockId: null, detail: null, users: [] },
};

const $ = (selector) => document.querySelector(selector);
const enc = (value) => encodeURIComponent(value);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const numberFormat = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTimeFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

const fmtPrice = (n) => numberFormat.format(n);
const fmtSigned = (n) => (n > 0 ? '+' : '') + numberFormat.format(n);
const fmtPct = (n) => (n > 0 ? '+' : '') + numberFormat.format(n) + ' %';
const fmtDate = (iso) => dateTimeFormat.format(new Date(iso));
const dirClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const arrow = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '–');
const canEdit = () => state.user?.role === 'root' || state.user?.role === 'admin';

async function api(path, options = {}) {
  const init = { method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error ?? `Fehler ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- Konto & Anmeldestatus ---------- */

async function loadAuth() {
  const status = await api('/api/auth/status');
  state.user = status.user;
  state.setupRequired = status.setupRequired;
  renderAccount();
}

function renderAccount() {
  const el = $('#account');
  if (!el) return;
  el.innerHTML = state.user
    ? `<span>${esc(state.user.username)} · <span class="tag">${esc(ROLE_LABELS[state.user.role] ?? state.user.role)}</span></span>
       <button type="button" class="ghost" data-action="logout">Abmelden</button>`
    : '';
}

/* ---------- Ticker & Markt-Daten ---------- */

async function fetchMarket() {
  state.market = await api('/api/market');
  renderTicker(state.market.stocks);
  return state.market;
}

function renderTicker(stocks) {
  const el = $('#ticker');
  if (!stocks.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const items = stocks
    .map(
      (s) =>
        `<a class="tick" href="#/stock/${enc(s.slug)}"><b>${esc(s.symbol)}</b>${fmtPrice(s.price)} <span class="${dirClass(s.changePct24h)}">${fmtPct(s.changePct24h)}</span></a>`,
    )
    .join('');
  const html = `<div class="ticker-track"><span>${items}</span><span aria-hidden="true">${items}</span></div>`;
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function sparkline(values, cls) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(30 - ((v - min) / span) * 28 - 1).toFixed(2)}`)
    .join(' ');
  return `<svg class="spark ${cls}" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

/* ---------- Marktübersicht ---------- */

async function viewMarket() {
  const token = ++state.token;
  await fetchMarket();
  if (token !== state.token) return;
  $('#app').innerHTML = `
    <section class="hero">
      <div>
        <h1>Projekt-Aktien</h1>
        <p class="lead">Meilensteine treiben den Kurs. Rückschläge kosten Punkte.</p>
      </div>
      <div class="grid-stats" id="hero-stats" style="margin:0"></div>
    </section>
    <section class="movers" id="movers"></section>
    <section class="card">
      <div class="toolbar">
        <input id="filter" type="search" placeholder="Name oder Kürzel suchen" aria-label="Aktien filtern" value="${esc(state.filter)}">
      </div>
      <div id="market-table" class="table-wrap"></div>
    </section>`;
  state.refresh = () => {
    drawHero();
    drawMovers();
    drawMarketTable();
  };
  state.refresh();
}

function drawHero() {
  const el = $('#hero-stats');
  if (!el || !state.market) return;
  const stocks = state.market.stocks;
  const gainers = stocks.filter((s) => s.changePct24h > 0).length;
  const losers = stocks.filter((s) => s.changePct24h < 0).length;
  el.innerHTML = [
    ['Projekte', String(stocks.length)],
    ['Steigend (24 h)', `<span class="up">${gainers}</span>`],
    ['Fallend (24 h)', `<span class="down">${losers}</span>`],
  ]
    .map(([label, value]) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`)
    .join('');
}

function drawMovers() {
  const el = $('#movers');
  if (!el || !state.market) return;
  const stocks = state.market.stocks;
  if (!stocks.length) {
    el.innerHTML = '';
    return;
  }
  const top = [...stocks].sort((a, b) => b.changePct24h - a.changePct24h);
  const best = top[0];
  const worst = top[top.length - 1];
  const card = (title, s) => `
    <a class="mover" href="#/stock/${enc(s.slug)}">
      <div class="muted small">${title}</div>
      <div><span class="sym">${esc(s.symbol)}</span> · ${esc(s.name)}</div>
      <div class="pct ${dirClass(s.changePct24h)}">${arrow(s.changePct24h)} ${fmtPct(s.changePct24h)}</div>
    </a>`;
  el.innerHTML = card('Top-Gewinner (24 h)', best) + card('Top-Verlierer (24 h)', worst);
}

function sortValue(stock, key) {
  return key === 'symbol' ? stock.symbol : key === 'name' ? stock.name : stock[key];
}

function drawMarketTable() {
  const el = $('#market-table');
  if (!el || !state.market) return;
  const stocks = state.market.stocks;
  const q = state.filter.trim().toLowerCase();
  const matches = (s) => !q || s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q);
  const { key, dir } = state.sort;
  const cmp = (a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
  };

  const rows = [];
  for (const root of stocks.filter((s) => s.parentId === null).sort(cmp)) {
    const kids = stocks.filter((s) => s.parentId === root.id).sort(cmp);
    if (!(matches(root) || kids.some(matches))) continue;
    rows.push(marketRow(root, false));
    for (const kid of kids) {
      if (matches(kid) || matches(root)) rows.push(marketRow(kid, true));
    }
  }

  const header = (label, sortKey, numeric = false) => {
    const active = state.sort.key === sortKey;
    const indicator = active ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '';
    return `<th class="${numeric ? 'num' : ''}"><button type="button" data-sort="${sortKey}">${label}${indicator}</button></th>`;
  };

  el.innerHTML = rows.length
    ? `<table>
        <thead><tr>
          ${header('Kürzel', 'symbol')}
          ${header('Name', 'name')}
          ${header('Kurs', 'price', true)}
          ${header('24 h', 'changePct24h', true)}
          <th>Verlauf 7 T</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>`
    : `<p class="empty">${stocks.length ? 'Keine Treffer.' : 'Noch keine Aktien angelegt.'}</p>`;
}

function marketRow(s, child) {
  const cls = dirClass(s.changePct24h);
  const href = `#/stock/${enc(s.slug)}`;
  return `<tr class="${child ? 'child' : ''}" data-href="${href}" tabindex="0">
    <td><span class="symbol">${child ? '↳ ' : ''}${esc(s.symbol)}</span></td>
    <td><a class="name" href="${href}">${esc(s.name)}</a></td>
    <td class="num">${fmtPrice(s.price)}</td>
    <td class="num ${cls}">${fmtPct(s.changePct24h)}</td>
    <td class="spark-cell">${sparkline(s.spark, cls)}</td>
  </tr>`;
}

/* ---------- Aktien-Detailseite ---------- */

function buildSeries(points, current, from, to) {
  let start = points[0].price;
  for (const p of points) {
    if (p.t <= from) start = p.price;
    else break;
  }
  const out = [{ t: from, price: start, event: null }];
  for (const p of points) {
    if (p.t > from && p.t <= to) out.push(p);
  }
  out.push({ t: to, price: current, event: null });
  return out;
}

function drawChart() {
  const el = $('#chart');
  if (!el || !state.stock) return;
  const { stock, history } = state.stock;
  const now = Date.now();
  const listed = Date.parse(stock.listedAt);
  const days = RANGES.find(([label]) => label === state.range)?.[1] ?? null;
  const from = days === null ? listed : Math.max(listed, now - days * DAY);
  const points = history.map((p) => ({ t: Date.parse(p.t), price: p.price, event: p.event }));
  const pts = buildSeries(points, stock.price, from, now);

  const W = 800;
  const H = 320;
  const L = 64;
  const R = 12;
  const T = 16;
  const B = 28;
  const values = pts.map((p) => p.price);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = (hi - lo) * 0.1 || Math.max(hi, 1) * 0.05;
  lo = Math.max(0, lo - pad);
  hi = hi + pad;
  const x = (t) => L + ((t - from) / Math.max(now - from, 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  let line = `M${x(pts[0].t).toFixed(1)} ${y(pts[0].price).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    line += ` H${x(pts[i].t).toFixed(1)} V${y(pts[i].price).toFixed(1)}`;
  }
  const area = `${line} V${H - B} H${x(pts[0].t).toFixed(1)} Z`;
  const cls = dirClass(stock.price - pts[0].price);
  const color = cls === 'down' ? DOWN : UP;

  const grid = [0, 1, 2, 3]
    .map((i) => {
      const v = lo + ((hi - lo) * i) / 3;
      return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
              <text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtPrice(v)}</text>`;
    })
    .join('');

  const axisLabel = (t) => (days !== null && days <= 1 ? timeFormat.format(t) : dayFormat.format(t));
  const xLabels = [
    [from, 'start'],
    [(from + now) / 2, 'middle'],
    [now, 'end'],
  ]
    .map(([t, anchor]) => `<text class="axis" x="${x(t)}" y="${H - 8}" text-anchor="${anchor}">${axisLabel(t)}</text>`)
    .join('');

  const dots = pts
    .filter((p) => p.event)
    .map((p) => `<circle class="dot ${dirClass(p.event.delta)}" cx="${x(p.t)}" cy="${y(p.price)}" r="4.5"/>`)
    .join('');

  el.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kursverlauf von ${esc(stock.name)}">
      <defs>
        <linearGradient id="chart-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#chart-area)"/>
      <path class="line ${cls}" d="${line}" fill="none"/>
      ${dots}
      <line class="cross" id="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" hidden/>
      <circle class="hover-dot" id="hover" r="5" cx="0" cy="0" hidden/>
      ${xLabels}
      <rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="#000" fill-opacity="0"/>
    </svg>
    <div class="tooltip" id="tip" hidden></div>`;

  const svg = el.querySelector('svg');
  const tip = el.querySelector('#tip');
  const cross = el.querySelector('#cross');
  const hover = el.querySelector('#hover');
  const hit = el.querySelector('#hit');
  hit.addEventListener('pointermove', (event) => {
    const r = svg.getBoundingClientRect();
    const vx = ((event.clientX - r.left) / r.width) * W;
    let best = 0;
    let bestDistance = Infinity;
    pts.forEach((p, i) => {
      const distance = Math.abs(x(p.t) - vx);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    const p = pts[best];
    const px = x(p.t);
    cross.setAttribute('x1', String(px));
    cross.setAttribute('x2', String(px));
    cross.removeAttribute('hidden');
    hover.setAttribute('cx', String(px));
    hover.setAttribute('cy', String(y(p.price)));
    hover.removeAttribute('hidden');
    tip.hidden = false;
    tip.style.left = `${(px / W) * r.width}px`;
    tip.innerHTML = `<strong>${fmtPrice(p.price)} ${UNIT}</strong><br><span class="muted">${fmtDate(new Date(p.t).toISOString())}</span>${
      p.event ? `<br>${esc(p.event.title)} <span class="${dirClass(p.event.delta)}">${fmtSigned(p.event.delta)}</span>` : ''
    }`;
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('hidden', '');
    hover.setAttribute('hidden', '');
    tip.hidden = true;
  });
}

function eventItem(e, planned) {
  return `<li class="event ${planned ? 'planned' : ''}">
    <div><span class="delta-chip delta ${dirClass(e.delta)}">${fmtSigned(e.delta)}</span></div>
    <div>
      <strong>${esc(e.title)}</strong>${planned ? '<span class="tag">geplant</span>' : ''}
      <div class="muted small">${planned ? `wird angewendet am ${fmtDate(e.occursAt)}` : `${fmtDate(e.occursAt)} · Kurs danach ${fmtPrice(e.priceAfter)} ${UNIT}`}</div>
      ${e.description ? `<p>${esc(e.description)}</p>` : ''}
    </div>
  </li>`;
}

function statCard(label, value) {
  return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function drawStock() {
  const { stock: s, parent, children, events, scheduled } = state.stock;
  const cls = dirClass(s.change24h);
  const perf = s.stats.performancePct;
  $('#app').innerHTML = `
    <nav class="crumbs">
      <a href="#/">Markt</a>${parent ? ` / <a href="#/stock/${enc(parent.slug)}">${esc(parent.name)}</a>` : ''} / <span>${esc(s.name)}</span>
    </nav>
    <section class="card">
      <div class="quote-head">
        <div>
          <span class="badge">${esc(s.symbol)}</span>
          <h1>${esc(s.name)}</h1>
          ${parent ? `<p class="muted">Unterprojekt von ${esc(parent.name)}</p>` : ''}
        </div>
        <div class="price-block">
          <div class="price">${fmtPrice(s.price)} <span class="unit">${UNIT}</span></div>
          <div class="change ${cls}">${arrow(s.change24h)} ${fmtSigned(s.change24h)} (${fmtPct(s.changePct24h)}) <span class="muted">24 h</span></div>
        </div>
      </div>
      <div class="range-bar" role="group" aria-label="Zeitraum">
        ${RANGES.map(([label]) => `<button type="button" data-range="${label}" class="${label === state.range ? 'active' : ''}">${label}</button>`).join('')}
      </div>
      <div class="chart" id="chart"></div>
    </section>

    <section class="grid-stats">
      ${statCard('Performance seit IPO', `<span class="${dirClass(perf)}">${fmtPct(perf)}</span>`)}
      ${statCard('Allzeithoch', fmtPrice(s.stats.high))}
      ${statCard('Allzeittief', fmtPrice(s.stats.low))}
      ${statCard('Startkurs', fmtPrice(s.startPrice))}
      ${statCard('Meilensteine', String(s.stats.milestoneCount))}
      ${statCard('Notiert seit', fmtDate(s.listedAt))}
    </section>

    <div class="two-col">
      <section class="card">
        <h2>Meilensteine</h2>
        ${events.length ? `<ul class="events">${events.map((e) => eventItem(e, false)).join('')}</ul>` : '<p class="empty">Noch keine Meilensteine.</p>'}
      </section>
      <section class="card">
        <h2>Geplant</h2>
        ${scheduled.length ? `<ul class="events">${scheduled.map((e) => eventItem(e, true)).join('')}</ul>` : '<p class="empty">Keine geplanten Ereignisse.</p>'}
      </section>
    </div>

    <section class="card">
      <h2>Über das Projekt</h2>
      <p class="description">${s.description ? esc(s.description) : '<span class="muted">Keine Beschreibung hinterlegt.</span>'}</p>
      ${s.url ? `<p><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Projekt öffnen ↗</a></p>` : ''}
    </section>

    ${
      children.length
        ? `<section class="card"><h2>Unterprojekte</h2><div class="child-grid">${children
            .map(
              (c) => `<a class="child-card" href="#/stock/${enc(c.slug)}">
                <span class="badge">${esc(c.symbol)}</span>
                <div>${esc(c.name)}</div>
                <div class="num">${fmtPrice(c.price)} ${UNIT}</div>
                <div class="${dirClass(c.changePct24h)}">${fmtPct(c.changePct24h)}</div>
              </a>`,
            )
            .join('')}</div></section>`
        : ''
    }`;
  drawChart();
}

async function viewStock(slug) {
  const token = ++state.token;
  let data;
  try {
    data = await api(`/api/stocks/${enc(slug)}`);
  } catch (err) {
    if (token !== state.token) return;
    $('#app').innerHTML = `<section class="card"><h1>Aktie nicht gefunden</h1><p class="muted">${esc(err.message)}</p><p><a href="#/">Zurück zum Markt</a></p></section>`;
    state.refresh = null;
    return;
  }
  if (token !== state.token) return;
  state.stock = data;
  state.stockSlug = slug;
  state.refresh = async () => {
    const fresh = await api(`/api/stocks/${enc(slug)}`);
    if (state.stockSlug === slug) {
      state.stock = fresh;
      drawStock();
    }
  };
  drawStock();
}

/* ---------- Admin: Anmeldung & Ersteinrichtung ---------- */

async function viewAdmin() {
  const token = ++state.token;
  state.refresh = null;
  await loadAuth();
  if (token !== state.token) return;
  if (state.setupRequired) {
    renderSetup();
  } else if (!state.user) {
    renderLogin();
  } else {
    await renderConsole(token);
  }
}

function renderSetup() {
  $('#app').innerHTML = `
    <section class="card narrow">
      <h1>Ersteinrichtung</h1>
      <p class="muted">Lege das Root-Konto an. Es verwaltet später alle weiteren Admin- und Lese-Konten.</p>
      <form id="setup-form" class="stack">
        <label>Benutzername<input name="username" required autocomplete="username" maxlength="32" placeholder="z. B. admin"></label>
        <label>Passwort (mindestens 12 Zeichen)<input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
        <label>Passwort wiederholen<input name="passwordRepeat" type="password" required minlength="12" autocomplete="new-password"></label>
        <button class="primary" type="submit">Root-Konto anlegen</button>
        <p class="error" id="form-error" role="alert"></p>
      </form>
    </section>`;
}

function renderLogin() {
  $('#app').innerHTML = `
    <section class="card narrow">
      <h1>Anmelden</h1>
      <form id="login-form" class="stack">
        <label>Benutzername<input name="username" required autocomplete="username"></label>
        <label>Passwort<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary" type="submit">Anmelden</button>
        <p class="error" id="form-error" role="alert"></p>
      </form>
    </section>`;
}

/* ---------- Admin: Konsole ---------- */

const LOCAL_DT_LENGTH = 16;
/** Formatiert ein Datum als Wert für <input type="datetime-local"> (lokale Zeit). */
function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`.slice(0, LOCAL_DT_LENGTH);
}

function toIsoFromLocal(value) {
  return value ? new Date(value).toISOString() : undefined;
}

function stockFormsHtml() {
  return `
    <div class="admin-grid">
      <section class="card">
        <h2 id="stock-form-title">Neue Aktie anlegen</h2>
        <form id="stock-form" class="stack">
          <div class="row">
            <label>Name<input name="name" required maxlength="80" placeholder="z. B. Mein Projekt"></label>
            <label>Kürzel<input name="symbol" required maxlength="8" pattern="[A-Za-z0-9]{2,8}" placeholder="z. B. MPJ"></label>
          </div>
          <div class="row">
            <label>Startkurs<input name="startPrice" type="number" step="0.01" min="0.01" value="100"></label>
            <label>Notiert seit<input name="listedAt" type="datetime-local" value="${toLocalInput(new Date())}"></label>
          </div>
          <label>Übergeordnetes Projekt<select name="parentId"></select></label>
          <label>Link zum Projekt<input name="url" type="url" maxlength="300" placeholder="https://…"></label>
          <label>Beschreibung<textarea name="description" maxlength="2000"></textarea></label>
          <div class="actions">
            <button class="primary" type="submit" id="stock-submit">Aktie anlegen</button>
            <button type="button" id="stock-cancel" hidden>Abbrechen</button>
          </div>
          <p class="error" id="stock-error" role="alert"></p>
        </form>
      </section>

      <section class="card">
        <h2 id="event-form-title">Meilenstein / Ereignis eintragen</h2>
        <form id="event-form" class="stack">
          <label>Aktie<select name="stockId" required></select></label>
          <label>Titel<input name="title" required maxlength="120" placeholder="z. B. Version 1.0 veröffentlicht"></label>
          <label>Wert (+ steigt, − fällt)<input name="delta" type="number" step="0.01" required placeholder="z. B. 12,50 oder -5"></label>
          <label>Zeitpunkt<input name="occursAt" type="datetime-local" value="${toLocalInput(new Date())}"></label>
          <p class="hint" id="event-hint"></p>
          <label>Beschreibung<textarea name="description" maxlength="2000"></textarea></label>
          <div class="actions">
            <button class="primary" type="submit" id="event-submit">Ereignis eintragen</button>
            <button type="button" id="event-cancel" hidden>Abbrechen</button>
          </div>
          <p class="error" id="event-error" role="alert"></p>
        </form>
      </section>
    </div>`;
}

function usersHtml() {
  return `
    <section class="card">
      <h2>Benutzer</h2>
      <p class="hint">Root: alles inklusive Benutzerverwaltung · Admin: Aktien und Ereignisse · Lesend: nur einsehen.</p>
      <div id="admin-users" class="table-wrap"></div>
      <h3>Neues Konto</h3>
      <form id="user-form" class="stack">
        <div class="row">
          <label>Benutzername<input name="username" required maxlength="32"></label>
          <label>Rolle<select name="role">
            <option value="admin">Admin</option>
            <option value="viewer">Lesend</option>
            <option value="root">Root</option>
          </select></label>
        </div>
        <label>Startpasswort (mindestens 12 Zeichen)<input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
        <div class="actions"><button class="primary" type="submit">Konto anlegen</button></div>
        <p class="error" id="user-error" role="alert"></p>
      </form>
    </section>`;
}

async function renderConsole(token) {
  const write = canEdit();
  const isRoot = state.user.role === 'root';
  $('#app').innerHTML = `
    <section class="card">
      <div class="admin-head">
        <div>
          <h1>Admin</h1>
          <p class="muted">${
            write
              ? 'Aktien anlegen, Meilensteine (+/−) eintragen und Ereignisse planen.'
              : 'Lesezugriff: Du siehst alle Daten, kannst aber nichts ändern.'
          }</p>
        </div>
        <button type="button" class="ghost" data-action="change-password">Mein Passwort ändern</button>
      </div>
    </section>
    ${write ? stockFormsHtml() : ''}
    <section class="card">
      <h2>Aktien</h2>
      <div id="admin-stocks" class="table-wrap"></div>
    </section>
    <section class="card">
      <div class="admin-head">
        <h2>Ereignisse</h2>
        <label style="min-width:240px">Aktie
          <select id="event-stock-filter"></select>
        </label>
      </div>
      <div id="admin-events" class="table-wrap"></div>
    </section>
    ${isRoot ? usersHtml() : ''}`;

  if (write) {
    $('#event-form [name="occursAt"]').addEventListener('input', updateEventHint);
  }
  await refreshAdmin(token);
  if (isRoot) await refreshUsers(token);
}

function updateEventHint() {
  const input = $('#event-form [name="occursAt"]');
  const hint = $('#event-hint');
  if (!input || !hint) return;
  const when = toIsoFromLocal(input.value);
  if (when && Date.parse(when) > Date.now()) {
    hint.className = 'hint planned';
    hint.textContent = `Geplant: wird automatisch am ${fmtDate(when)} angewendet.`;
  } else {
    hint.className = 'hint';
    hint.textContent = 'Zeitpunkt in der Vergangenheit oder jetzt: wird sofort angewendet.';
  }
}

function fillStockSelects(stocks) {
  const options = stocks.map((s) => `<option value="${s.id}">${esc(s.symbol)} · ${esc(s.name)}</option>`).join('');
  const filter = $('#event-stock-filter');
  if (filter) {
    filter.innerHTML = options;
    filter.value = String(state.admin.eventStockId ?? '');
  }
  const parentSelect = $('#stock-form [name="parentId"]');
  const eventSelect = $('#event-form [name="stockId"]');
  if (parentSelect) {
    const parentValue = parentSelect.value;
    const editing = state.admin.stockEditId;
    parentSelect.innerHTML =
      '<option value="">– kein (eigenständige Aktie) –</option>' +
      stocks
        .filter((s) => s.id !== editing)
        .map((s) => `<option value="${s.id}">${esc(s.symbol)} · ${esc(s.name)}</option>`)
        .join('');
    parentSelect.value = parentValue;
  }
  if (eventSelect) {
    const eventValue = eventSelect.value || String(state.admin.eventStockId ?? '');
    eventSelect.innerHTML = options;
    eventSelect.value = eventValue;
  }
}

async function refreshAdmin(token) {
  const market = await fetchMarket();
  if (token !== undefined && token !== state.token) return;
  const stocks = market.stocks;
  if (!state.admin.eventStockId || !stocks.some((s) => s.id === state.admin.eventStockId)) {
    state.admin.eventStockId = stocks[0]?.id ?? null;
  }
  fillStockSelects(stocks);
  drawAdminStocks(stocks);

  const selected = stocks.find((s) => s.id === state.admin.eventStockId);
  state.admin.detail = selected ? await api(`/api/stocks/${enc(selected.slug)}`) : null;
  drawAdminEvents();
}

function drawAdminStocks(stocks) {
  const el = $('#admin-stocks');
  if (!el) return;
  if (!stocks.length) {
    el.innerHTML = '<p class="empty">Noch keine Aktien.</p>';
    return;
  }
  const write = canEdit();
  const byId = new Map(stocks.map((s) => [s.id, s]));
  el.innerHTML = `<table>
    <thead><tr><th>Kürzel</th><th>Name</th><th>Kurs</th><th>Oberprojekt</th>${write ? '<th>Aktionen</th>' : ''}</tr></thead>
    <tbody>${stocks
      .map(
        (s) => `<tr>
          <td><span class="symbol">${esc(s.symbol)}</span></td>
          <td><a href="#/stock/${enc(s.slug)}">${esc(s.name)}</a></td>
          <td class="num">${fmtPrice(s.price)}</td>
          <td>${s.parentId ? esc(byId.get(s.parentId)?.name ?? '') : '–'}</td>
          ${
            write
              ? `<td><div class="actions">
                  <button type="button" data-action="edit-stock" data-id="${s.id}">Bearbeiten</button>
                  <button type="button" class="danger" data-action="delete-stock" data-id="${s.id}">Löschen</button>
                </div></td>`
              : ''
          }
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function drawAdminEvents() {
  const el = $('#admin-events');
  if (!el) return;
  const detail = state.admin.detail;
  if (!detail) {
    el.innerHTML = '<p class="empty">Noch keine Aktie vorhanden.</p>';
    return;
  }
  const all = [
    ...detail.scheduled.map((e) => ({ ...e, planned: true })),
    ...detail.events.map((e) => ({ ...e, planned: false })),
  ];
  if (!all.length) {
    el.innerHTML = '<p class="empty">Noch keine Ereignisse für diese Aktie.</p>';
    return;
  }
  const write = canEdit();
  el.innerHTML = `<table>
    <thead><tr><th>Zeitpunkt</th><th>Titel</th><th class="num">Wert</th><th>Status</th><th class="num">Kurs danach</th>${write ? '<th>Aktionen</th>' : ''}</tr></thead>
    <tbody>${all
      .map(
        (e) => `<tr>
          <td>${fmtDate(e.occursAt)}</td>
          <td>${esc(e.title)}</td>
          <td class="num ${dirClass(e.delta)}">${fmtSigned(e.delta)}</td>
          <td>${e.planned ? '<span class="tag">geplant</span>' : 'angewendet'}</td>
          <td class="num">${e.priceAfter === null || e.priceAfter === undefined ? '–' : fmtPrice(e.priceAfter)}</td>
          ${
            write
              ? `<td><div class="actions">
                  <button type="button" data-action="edit-event" data-id="${e.id}">Bearbeiten</button>
                  ${e.planned ? `<button type="button" data-action="apply-event" data-id="${e.id}">Jetzt anwenden</button>` : ''}
                  <button type="button" class="danger" data-action="delete-event" data-id="${e.id}">Löschen</button>
                </div></td>`
              : ''
          }
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

async function refreshUsers(token) {
  const data = await api('/api/admin/users');
  if (token !== state.token) return;
  state.admin.users = data.users;
  const el = $('#admin-users');
  if (!el) return;
  const roleOptions = (selected) =>
    ['root', 'admin', 'viewer']
      .map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)
      .join('');
  el.innerHTML = `<table>
    <thead><tr><th>Benutzername</th><th>Rolle</th><th>Angelegt</th><th>Aktionen</th></tr></thead>
    <tbody>${data.users
      .map((u) => {
        const self = u.id === state.user.id;
        return `<tr>
          <td>${esc(u.username)}${self ? ' <span class="tag">du</span>' : ''}</td>
          <td><select data-user-role="${u.id}" aria-label="Rolle von ${esc(u.username)}">${roleOptions(u.role)}</select></td>
          <td>${fmtDate(u.createdAt)}</td>
          <td><div class="actions">
            <button type="button" data-action="user-password" data-id="${u.id}" data-name="${esc(u.username)}">Passwort setzen</button>
            ${self ? '' : `<button type="button" class="danger" data-action="delete-user" data-id="${u.id}" data-name="${esc(u.username)}">Löschen</button>`}
          </div></td>
        </tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

function resetStockForm() {
  state.admin.stockEditId = null;
  const form = $('#stock-form');
  form.reset();
  form.elements.startPrice.disabled = false;
  form.elements.listedAt.disabled = false;
  form.elements.listedAt.value = toLocalInput(new Date());
  $('#stock-form-title').textContent = 'Neue Aktie anlegen';
  $('#stock-submit').textContent = 'Aktie anlegen';
  $('#stock-cancel').hidden = true;
  $('#stock-error').textContent = '';
  fillStockSelects(state.market?.stocks ?? []);
}

function resetEventForm() {
  state.admin.eventEditId = null;
  const form = $('#event-form');
  const keepStock = form.elements.stockId.value;
  form.reset();
  form.elements.stockId.value = keepStock;
  form.elements.occursAt.value = toLocalInput(new Date());
  $('#event-form-title').textContent = 'Meilenstein / Ereignis eintragen';
  $('#event-submit').textContent = 'Ereignis eintragen';
  $('#event-cancel').hidden = true;
  $('#event-error').textContent = '';
  updateEventHint();
}

function startEditStock(id) {
  const stock = state.market?.stocks.find((s) => s.id === id);
  if (!stock) return;
  state.admin.stockEditId = id;
  const form = $('#stock-form');
  form.elements.name.value = stock.name;
  form.elements.symbol.value = stock.symbol;
  form.elements.description.value = stock.description ?? '';
  form.elements.url.value = stock.url ?? '';
  fillStockSelects(state.market.stocks);
  form.elements.parentId.value = stock.parentId ? String(stock.parentId) : '';
  form.elements.startPrice.value = String(stock.startPrice);
  form.elements.startPrice.disabled = true;
  form.elements.listedAt.value = toLocalInput(new Date(stock.listedAt));
  form.elements.listedAt.disabled = true;
  $('#stock-form-title').textContent = `Aktie bearbeiten: ${stock.name}`;
  $('#stock-submit').textContent = 'Änderungen speichern';
  $('#stock-cancel').hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startEditEvent(id) {
  const event = state.admin.detail?.events.concat(state.admin.detail.scheduled).find((e) => e.id === id);
  if (!event) return;
  state.admin.eventEditId = id;
  const form = $('#event-form');
  form.elements.stockId.value = String(state.admin.eventStockId);
  form.elements.title.value = event.title;
  form.elements.description.value = event.description ?? '';
  form.elements.delta.value = String(event.delta);
  form.elements.occursAt.value = toLocalInput(new Date(event.occursAt));
  $('#event-form-title').textContent = `Ereignis bearbeiten: ${event.title}`;
  $('#event-submit').textContent = 'Änderungen speichern';
  $('#event-cancel').hidden = false;
  updateEventHint();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Ereignisse & Delegation ---------- */

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();

  if (form.id === 'setup-form') {
    const errorEl = $('#form-error');
    const f = form.elements;
    if (f.password.value !== f.passwordRepeat.value) {
      errorEl.textContent = 'Die Passwörter stimmen nicht überein';
      return;
    }
    try {
      await api('/api/auth/setup', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
      toast('Root-Konto angelegt');
      await viewAdmin();
    } catch (err) {
      errorEl.textContent = err.message;
    }
    return;
  }

  if (form.id === 'login-form') {
    const errorEl = $('#form-error');
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: { username: form.elements.username.value, password: form.elements.password.value },
      });
      await viewAdmin();
    } catch (err) {
      errorEl.textContent = err.message;
    }
    return;
  }

  if (form.id === 'user-form') {
    const errorEl = $('#user-error');
    errorEl.textContent = '';
    const f = form.elements;
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: { username: f.username.value, role: f.role.value, password: f.password.value },
      });
      toast('Konto angelegt');
      form.reset();
      await refreshUsers(state.token);
    } catch (err) {
      errorEl.textContent = err.message;
    }
    return;
  }

  if (form.id === 'stock-form') {
    const errorEl = $('#stock-error');
    errorEl.textContent = '';
    const f = form.elements;
    const parentRaw = f.parentId.value;
    const body = {
      name: f.name.value,
      symbol: f.symbol.value,
      description: f.description.value,
      url: f.url.value,
      parentId: parentRaw ? Number(parentRaw) : null,
    };
    try {
      if (state.admin.stockEditId) {
        await api(`/api/admin/stocks/${state.admin.stockEditId}`, { method: 'PUT', body });
        toast('Aktie gespeichert');
      } else {
        body.startPrice = Number(f.startPrice.value);
        body.listedAt = toIsoFromLocal(f.listedAt.value);
        await api('/api/admin/stocks', { method: 'POST', body });
        toast('Aktie angelegt');
      }
      resetStockForm();
      await refreshAdmin(state.token);
    } catch (err) {
      errorEl.textContent = err.message;
    }
    return;
  }

  if (form.id === 'event-form') {
    const errorEl = $('#event-error');
    errorEl.textContent = '';
    const f = form.elements;
    const body = {
      stockId: Number(f.stockId.value),
      title: f.title.value,
      description: f.description.value,
      delta: Number(f.delta.value),
      occursAt: toIsoFromLocal(f.occursAt.value),
    };
    try {
      if (state.admin.eventEditId) {
        await api(`/api/admin/events/${state.admin.eventEditId}`, { method: 'PUT', body });
        toast('Ereignis gespeichert');
      } else {
        await api('/api/admin/events', { method: 'POST', body });
        toast(Date.parse(body.occursAt) > Date.now() ? 'Ereignis geplant' : 'Meilenstein angewendet');
      }
      resetEventForm();
      await refreshAdmin(state.token);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.id === 'event-stock-filter') {
    state.admin.eventStockId = Number(target.value);
    const formSelect = $('#event-form [name="stockId"]');
    if (formSelect) formSelect.value = target.value;
    await refreshAdmin(state.token);
    return;
  }
  if (target.dataset.userRole) {
    try {
      await api(`/api/admin/users/${target.dataset.userRole}`, { method: 'PUT', body: { role: target.value } });
      toast('Rolle geändert');
    } catch (err) {
      toast(err.message, true);
    }
    await refreshUsers(state.token);
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === 'filter') {
    state.filter = target.value;
    drawMarketTable();
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const sortButton = target.closest('[data-sort]');
  if (sortButton) {
    const key = sortButton.dataset.sort;
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'symbol' || key === 'name' ? 1 : -1 };
    drawMarketTable();
    return;
  }

  const rangeButton = target.closest('[data-range]');
  if (rangeButton) {
    state.range = rangeButton.dataset.range;
    document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', b === rangeButton));
    drawChart();
    return;
  }

  const row = target.closest('tr[data-href]');
  if (row && !target.closest('a, button')) {
    location.hash = row.dataset.href;
    return;
  }

  const actionEl = target.closest('[data-action]');
  if (!actionEl) {
    if (target.id === 'stock-cancel') resetStockForm();
    if (target.id === 'event-cancel') resetEventForm();
    return;
  }
  const action = actionEl.dataset.action;
  const id = Number(actionEl.dataset.id);
  try {
    if (action === 'logout') {
      await api('/api/auth/logout', { method: 'POST', body: {} });
      await viewAdmin();
    } else if (action === 'change-password') {
      const currentPassword = prompt('Aktuelles Passwort:');
      if (!currentPassword) return;
      const newPassword = prompt('Neues Passwort (mindestens 12 Zeichen):');
      if (!newPassword) return;
      await api('/api/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      toast('Passwort geändert. Bitte erneut anmelden.');
      await viewAdmin();
    } else if (action === 'edit-stock') {
      startEditStock(id);
    } else if (action === 'delete-stock') {
      if (!confirm('Aktie wirklich löschen? Alle Ereignisse dieser Aktie werden entfernt.')) return;
      await api(`/api/admin/stocks/${id}`, { method: 'DELETE' });
      toast('Aktie gelöscht');
      resetStockForm();
      await refreshAdmin(state.token);
    } else if (action === 'edit-event') {
      startEditEvent(id);
    } else if (action === 'apply-event') {
      await api(`/api/admin/events/${id}/apply`, { method: 'POST', body: {} });
      toast('Ereignis sofort angewendet');
      await refreshAdmin(state.token);
    } else if (action === 'delete-event') {
      if (!confirm('Ereignis wirklich löschen? Die Kurse werden neu berechnet.')) return;
      await api(`/api/admin/events/${id}`, { method: 'DELETE' });
      toast('Ereignis gelöscht');
      await refreshAdmin(state.token);
    } else if (action === 'user-password') {
      const password = prompt(`Neues Passwort für ${actionEl.dataset.name} (mindestens 12 Zeichen):`);
      if (!password) return;
      await api(`/api/admin/users/${id}`, { method: 'PUT', body: { password } });
      toast('Passwort gesetzt. Alle Sitzungen dieses Kontos wurden beendet.');
    } else if (action === 'delete-user') {
      if (!confirm(`Konto „${actionEl.dataset.name}“ wirklich löschen?`)) return;
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      toast('Konto gelöscht');
      await refreshUsers(state.token);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- Router & Start ---------- */

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'stock' && parts[1]) {
    viewStock(decodeURIComponent(parts[1]));
  } else if (parts[0] === 'admin') {
    viewAdmin();
  } else {
    viewMarket();
  }
}

window.addEventListener('hashchange', route);

setInterval(async () => {
  if (document.hidden) return;
  try {
    await fetchMarket();
    if (state.refresh) await state.refresh();
  } catch {
    // Nächster Durchlauf versucht es erneut.
  }
}, REFRESH_MS);

(async () => {
  try {
    await loadAuth();
  } catch {
    // Ohne Status läuft die Seite ohne Konto weiter.
  }
  if (state.setupRequired && location.hash !== '#/admin') {
    location.hash = '#/admin';
  } else {
    route();
  }
})();
