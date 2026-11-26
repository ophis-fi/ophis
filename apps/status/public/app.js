// The page: reads /status.json (the monitor's state, apps/status/core.ts) and /incidents.json
// (notes written by hand) and draws them. Everything read from those files reaches the page as
// text or as a number, never as markup.
'use strict';

const SVG = 'http://www.w3.org/2000/svg';
const STALE_S = 240; // four missed rounds: the monitor itself is in trouble
const DAY_MS = 86_400_000;
const LABEL = { up: 'Operational', warn: 'Degraded', down: 'Down', '': 'Not checked yet' };
const WHY = {
  timeout: 'no answer in time',
  unreachable: 'cannot be reached',
  unhealthy: 'reports a fault',
  'bad response': 'unexpected answer',
  'data is stale': 'data is behind',
  'slow response': 'answering slowly',
};

const $ = (id) => document.getElementById(id);

function node(ns, tag, attrs, kids) {
  const e = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key === 'text') e.textContent = value;
    else e.setAttribute(key, value);
  }
  e.append(...kids);
  return e;
}
const h = (tag, attrs, ...kids) => node(null, tag, attrs, kids);
const s = (tag, attrs, ...kids) => node(SVG, tag, attrs, kids);

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const stampFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function span(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return hours < 48 ? plural(hours, 'hour') : plural(Math.round(hours / 24), 'day');
}
const ago = (seconds) => (seconds < 90 ? 'less than a minute ago' : `${span(seconds)} ago`);
const why = (w) =>
  Object.hasOwn(WHY, w)
    ? WHY[w]
    : /^http \d{3}$/.test(w)
      ? `answered with error ${w.slice(5)}`
      : '';

/** Never rounds up to 100%: one failed check in a quarter still shows. */
function uptime(days) {
  let checks = 0;
  let failed = 0;
  for (const [c, f] of days) {
    checks += c;
    failed += f;
  }
  if (!checks) return '';
  return failed ? `${(Math.floor((1 - failed / checks) * 10_000) / 100).toFixed(2)}%` : '100%';
}

/** The dot's colour, the headline and the line under it. */
function verdict(state, failed, now) {
  const fine = 'The services themselves may be fine.';
  if (failed) return ['', 'Status data is unavailable', `The monitor could not be read. ${fine}`];
  if (!state.svc)
    return ['', 'First checks in progress', 'The monitor has just started. Give it a minute.'];
  const age = now - state.t;
  if (age > STALE_S)
    return ['', 'Status data is delayed', `The monitor last reported ${ago(age)}. ${fine}`];
  const down = state.svc.filter((e) => e.st === 'down');
  const warn = state.svc.filter((e) => e.st === 'warn');
  const up = state.svc.filter((e) => e.st === 'up').length;
  const tally = `${up} of ${state.svc.length} services operational. Checked ${ago(age)}.`;
  const subject = (list) =>
    list.length === 1 ? `${list[0].name} is` : `${list.length} services are`;
  if (down.length) return ['down', `${subject(down)} down`, tally];
  if (warn.length) return ['warn', `${subject(warn)} degraded`, tally];
  if (up < state.svc.length) return ['', 'First checks in progress', tally];
  return ['up', 'All systems operational', tally];
}

/** One dot per day, or per check: the newest on the right, a bad one bigger. */
function strand(e, view, state) {
  const width = 540;
  const slots = view === 'days' ? 90 : 60;
  const pitch = width / slots;
  const size =
    view === 'days'
      ? { up: 2.1, warn: 3.2, down: 3.8, none: 1 }
      : { up: 2.8, warn: 3.6, down: 4.2, none: 1.2 };
  const today = Date.parse(state.day);
  const dots = [];
  let failures = 0;
  for (let slot = 0; slot < slots; slot++) {
    const back = slots - 1 - slot; // 0 is the newest
    let kind = 'none';
    let title;
    if (view === 'days') {
      const [checks, failed] = e.d[back] ?? [0, 0];
      if (checks) kind = !failed ? 'up' : failed / checks > 0.01 ? 'down' : 'warn';
      failures += failed;
      const day = dayFormat.format(today - back * DAY_MS);
      title = !checks
        ? `${day}: no data`
        : `${day}: ${uptime([[checks, failed]])}${failed ? `, ${failed} of ${plural(checks, 'check')} failed` : ''}`;
    } else {
      const code = e.h[e.h.length - 1 - back];
      if (code) kind = { u: 'up', w: 'warn', d: 'down' }[code] ?? 'none';
      if (code === 'd') failures++;
      const at = (e.at - back * e.every * 60) * 1000;
      title = code
        ? `About ${timeFormat.format(at)}: ${LABEL[kind].toLowerCase()}`
        : 'No check yet';
    }
    const dot = s(
      'circle',
      { class: kind, r: size[kind], cx: (slot + 0.5) * pitch },
      s('title', { text: title }),
    );
    // A bad dot is drawn last, over its neighbours.
    if (kind === 'warn' || kind === 'down') dots.push(dot);
    else dots.unshift(dot);
  }
  const label =
    view === 'days'
      ? `${uptime(e.d) || 'no data'} over ${plural(e.d.length, 'day')}`
      : `${plural(failures, 'failed check')} in the last ${e.h.length}`;
  return s(
    'svg',
    {
      class: 'strand',
      viewBox: `0 -6 ${width} 12`,
      preserveAspectRatio: 'xMaxYMid meet',
      role: 'img',
      'aria-label': label,
    },
    ...dots,
  );
}

function row(e, view, state, now) {
  const kids = [
    h('span', { class: `dot ${e.st}`.trim(), role: 'img', 'aria-label': LABEL[e.st] }),
    h('span', { text: e.name }),
    h('span', { class: 'num', text: view === 'days' ? uptime(e.d) : e.at ? `${e.ms} ms` : '' }),
    strand(e, view, state),
  ];
  if (e.st === 'warn' || e.st === 'down') {
    const reason = why(e.why);
    const text = `${LABEL[e.st]} for ${span(now - e.since)}${reason ? `: ${reason}` : ''}`;
    kids.push(h('span', { class: `why is-${e.st}`, text }));
  }
  return h('li', { class: 'row', id: e.id }, ...kids);
}

function groups(state, view, now) {
  return state.groups
    .map((name, g) => ({ name, members: state.svc.filter((e) => e.g === g) }))
    .filter((group) => group.members.length)
    .flatMap((group) => [
      h('h2', { text: group.name }),
      h('ul', {}, ...group.members.map((e) => row(e, view, state, now))),
    ]);
}

// ---- outages the monitor saw, and notes written by hand ----

/** Keeps the well-formed notes of incidents.json: a title and dated updates, oldest first. */
function clean(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (n) =>
      n &&
      typeof n.title === 'string' &&
      Array.isArray(n.updates) &&
      n.updates.length &&
      n.updates.every((u) => u && typeof u.text === 'string' && !Number.isNaN(Date.parse(u.at))),
  );
}

function history(state, notes, now) {
  const items = [
    ...state.ev.map((o) => ({ at: o.from, o })),
    ...notes.map((n) => ({ at: Date.parse(n.updates[0].at) / 1000, n })),
  ].sort((a, b) => b.at - a.at);
  if (!items.length) {
    const days = Math.max(...state.svc.map((e) => e.d.length));
    const since = dayFormat.format(Date.parse(state.day) - (days - 1) * DAY_MS);
    return [
      h('li', { class: 'quiet', text: `No outage recorded since monitoring began on ${since}.` }),
    ];
  }
  return items.map(({ at, o, n }) => {
    const when = h('time', {
      datetime: new Date(at * 1000).toISOString(),
      text: stampFormat.format(at * 1000),
    });
    if (n) {
      const updates = n.updates.map((u) =>
        h('p', { class: 'more', text: `${stampFormat.format(Date.parse(u.at))}: ${u.text}` }),
      );
      return h(
        'li',
        { class: 'event' },
        when,
        h('div', {}, h('p', {}, h('strong', { text: n.title })), ...updates),
      );
    }
    const reason = why(o.why);
    const text =
      (o.to === null
        ? `${o.name} has been down for ${span(now - o.from)}`
        : `${o.name} was down for ${span(o.to - o.from)}`) + (reason ? ` (${reason}).` : '.');
    return h('li', { class: 'event' }, when, h('p', { text }));
  });
}

// ---- reading and drawing ----

let state = {};
let notes = [];
let failed = false;
let view = null;
let loadedAt = 0;

function draw() {
  const now = Date.now() / 1000;
  const [kind, headline, summary] = verdict(state, failed, now);
  $('lamp').className = `dot ${kind}`.trim();
  $('verdict').textContent = headline;
  $('summary').textContent = summary;

  const open = notes.filter((n) => n.status !== 'resolved');
  $('notes').hidden = !open.length;
  $('notes').replaceChildren(
    ...open.map((n) => {
      const last = n.updates[n.updates.length - 1];
      const when = h('time', { text: stampFormat.format(Date.parse(last.at)) });
      return h('p', { class: 'note' }, h('strong', { text: n.title }), `${last.text} `, when);
    }),
  );

  const ready = !failed && Array.isArray(state.svc);
  $('board').hidden = $('history').hidden = !ready;
  if (!ready) return;
  view ??= state.svc.some((e) => e.d.length > 1) ? 'days' : 'recent';
  for (const button of document.querySelectorAll('.switch button')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  $('groups').replaceChildren(...groups(state, view, now));
  $('log').replaceChildren(...history(state, notes, now));
}

async function load() {
  loadedAt = Date.now();
  try {
    const response = await fetch('/status.json');
    if (!response.ok) throw new Error(String(response.status));
    state = await response.json();
    failed = false;
  } catch {
    failed = true;
  }
  try {
    const response = await fetch('/incidents.json');
    if (response.ok) notes = clean(await response.json());
  } catch {
    // Notes are optional: the monitor's own state still draws.
  }
  draw();
}

for (const button of document.querySelectorAll('.switch button')) {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    draw();
  });
}
// A hidden tab asks for nothing: each read of /status.json is one of the account's daily requests.
setInterval(() => {
  if (!document.hidden) load();
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - loadedAt > 60_000) load();
});
load();
