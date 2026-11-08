// Check your setup: what this machine has for matches and for "Make video" (GET /api/doctor, see server/doctor.mjs).
import { $, el, api, header } from './common.js';

const app = $('#app');
const list = el('div', { class: 'list' });
const verdict = el('p', { class: 'sub' }, 'Checking ...');
const LABEL = { ok: 'ok', missing: 'missing', optional: 'optional' };

function row(i) {
  return el('div', { class: 'mcard' },
    el('div', {},
      el('div', { class: 'vs' }, i.label, i.needed_for ? el('span', { class: 'dim', style: 'font-weight:400;font-size:12px' }, `needed for ${i.needed_for}`) : null),
      el('div', { class: 'meta' }, el('span', {}, i.detail)),
      i.status !== 'ok' && i.fix ? el('p', { class: 'hint', style: 'margin-top:6px' }, i.fix) : null),
    el('div', { class: 'act' }, el('span', { class: 'badge ' + i.status }, LABEL[i.status] || i.status)));
}

async function check() {
  verdict.textContent = 'Checking ...';
  try {
    const d = await api('/api/doctor');
    list.replaceChildren(...d.items.map(row));
    verdict.textContent = !d.ok ? 'Something blocks matches on this machine. Fix the items marked missing above.'
      : d.video_ready ? 'Everything is in place: you can play matches and make videos.'
        : 'You can play and watch matches. "Make video" needs the items marked missing.';
  } catch (e) { list.replaceChildren(el('div', { class: 'err' }, e.message)); verdict.textContent = ''; }
}

app.append(header(), el('h1', {}, 'Check your setup'), verdict, el('h2', {}, 'This machine'), list,
  el('div', { class: 'playbar' }, el('button', { class: 'btn', type: 'button', onclick: check }, 'Check again'), el('a', { class: 'btn primary big', href: '/new' }, 'Connect your model')));
await check();
