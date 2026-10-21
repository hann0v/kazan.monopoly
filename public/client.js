const { SQ, GROUPS } = BOARD;
const $ = q => document.querySelector(q);
const sock = io();
const store = (k, v) => { try { return v === undefined ? sessionStorage[k] : (sessionStorage[k] = v); } catch { } };
const ID = store('mid') || store('mid', Math.random().toString(36).slice(2, 12));

let S = null, ROOM = null, NAME = '', modal = null, rolling = false, moveAt = 0, aucEnd = 0;
const shown = {}; // позиции фишек, которые сейчас нарисованы (для пошаговой анимации)

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gold = n => n.toLocaleString('ru-RU') + ' г';
const pl = id => S.players.find(p => p.id === id);
const short = n => n.replace(/^(ул\.|пр\.) /, '');
const send = (t, o = {}) => sock.emit('act', { t, ...o });
const B = (a, label, attrs = '', dis = false) => `<button data-a="${a}" ${attrs}${dis ? ' disabled' : ''}>${label}</button>`;
const built = i => SQ[i].type === 'street' && SQ.some((s, j) => s.group === SQ[i].group && S.props[j]?.houses);
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const die = n => `<div class="die">${[...Array(9)].map((_, k) => `<i${PIPS[n].includes(k) ? ' class="on"' : ''}></i>`).join('')}</div>`;

// ---------- вход ----------
const params = new URLSearchParams(location.search);
$('#code').value = params.get('r') || '';
try { $('#name').value = localStorage.mname || ''; } catch { }

function join(room) {
  NAME = $('#name').value.trim() || 'Игрок';
  try { localStorage.mname = NAME; } catch { }
  sock.emit('join', { room, name: NAME, id: ID });
}
$('#create').onclick = () => join('');
$('#enter').onclick = () => join($('#code').value);
if (params.get('r') && store('mroom') === params.get('r')) join(params.get('r'));

sock.on('joined', ({ room }) => {
  ROOM = room; store('mroom', room);
  history.replaceState(null, '', '?r=' + room);
  $('#lobby').hidden = true; $('#game').hidden = false;
});
sock.on('connect', () => { if (ROOM) sock.emit('join', { room: ROOM, name: NAME, id: ID }); });
sock.on('err', m => float(esc(m), 'bad'));
sock.on('state', s => {
  S = s;
  if (S.auction) aucEnd = Date.now() + S.auction.left;
  render();
});
sock.on('fx', onFx);

// ---------- поле ----------
const board = $('#board'), cells = [];
const pos = i => i <= 10 ? [11, 11 - i] : i <= 20 ? [21 - i, 1] : i <= 30 ? [1, i - 19] : [i - 29, 11];
const side = i => i % 10 === 0 ? 'k' : i < 10 ? 'b' : i < 20 ? 'l' : i < 30 ? 't' : 'r';
SQ.forEach((s, i) => {
  const d = document.createElement('div'), [r, c] = pos(i);
  d.className = `c ${side(i)} ${s.type}`;
  d.style.gridArea = `${r}/${c}`;
  if (s.group) d.style.setProperty('--g', GROUPS[s.group].c);
  d.innerHTML = `<b>${esc(short(s.name))}</b><small></small><span class="tks"></span>`;
  d.onclick = () => openProp(i);
  board.append(d); cells.push(d);
});

function render() {
  if (!S) return;
  const me = pl(ID), t = S.players[S.turn];
  board.classList.toggle('mine', S.started && S.phase !== 'over' && t?.id === ID);
  cells.forEach((d, i) => {
    const s = SQ[i], pr = S.props[i], o = pr && pl(pr.owner);
    d.classList.toggle('mort', !!pr?.mort);
    d.style.setProperty('--o', o ? o.color : 'transparent');
    d.querySelector('small').innerHTML = pr
      ? (pr.houses === 5 ? '<em class="h">■</em>' : '<em>' + '■'.repeat(pr.houses) + '</em>')
      : s.price ? s.price + ' г' : s.amount ? '−' + s.amount + ' г' : '';
  });
  renderTokens(); renderCenter(me, t); renderSide();
  if (modal?.live) drawModal();
}

function renderTokens() {
  cells.forEach(c => (c.lastChild.innerHTML = ''));
  const t = S.players[S.turn];
  for (const p of S.players) {
    if (shown[p.id] === undefined) shown[p.id] = p.pos;
    if (!p.bankrupt) cells[shown[p.id]].lastChild.insertAdjacentHTML('beforeend',
      `<i class="tk${S.started && p === t ? ' cur' : ''}" style="background:${p.color}"></i>`);
  }
}

// фишки шагают по клетке; в тюрьму и «назад на 3» — прыжком
setInterval(() => {
  if (!S || Date.now() < moveAt) return;
  let ch = false;
  for (const p of S.players) {
    const s = shown[p.id];
    if (s === undefined || s === p.pos) continue;
    const d = (p.pos - s + 40) % 40;
    shown[p.id] = p.jail || d >= 35 ? p.pos : (s + 1) % 40;
    ch = true;
  }
  if (ch) renderTokens();
}, 110);

function renderCenter(me, t) {
  const my = S.started && S.phase !== 'over' && t?.id === ID && !me?.bankrupt;
  if (!rolling) $('#dice').innerHTML = S.started && S.phase !== 'over' ? die(S.dice[0]) + die(S.dice[1]) : '';
  let st = '', a = '';

  if (!S.started) {
    a = `<div class="lob"><div>Комната <b class="code">${esc(ROOM)}</b></div>${B('ui-copy', 'Скопировать ссылку')}
      <ul>${S.players.map(p => `<li><i class="dot" style="background:${p.color}"></i>${esc(p.name)}${p.id === S.hostId ? ' · хост' : ''}</li>`).join('')}</ul>
      ${S.hostId === ID ? B('start', 'Начать игру', 'class="main"', S.players.length < 2) : '<p class="mut">Ждём, пока хост начнёт…</p>'}</div>`;
  } else if (S.phase === 'over') {
    st = `<div class="big">🏆 ${esc(pl(S.winner)?.name || '')} побеждает!</div>`;
  } else {
    const what = { roll: 'бросает кубики', move: 'ходит', buy: 'решает, покупать ли', auction: 'идёт аукцион', end: 'завершает ход' }[S.phase];
    st = `<i class="dot" style="background:${t.color}"></i>${my ? '<b>Ваш ход</b>' : `Ходит <b>${esc(t.name)}</b>`} · ${what}`;
    if (my && S.phase === 'roll' && S.doubles) st += '<br><span class="good">Дубль! Бросайте ещё раз</span>';
    if (t.jail) st += ' · 🔒 в тюрьме';

    if (my && S.phase === 'roll' && !S.auction) {
      if (me.jail) a += B('roll', 'Бросить на дубль', 'class="main"') + B('payjail', 'Заплатить 50 г', '', me.money < 50) + (me.jailCards.length ? B('card', 'Карта выхода') : '');
      else a += B('roll', 'Бросить кубики', 'class="main"');
    }
    if (my && S.phase === 'buy') {
      const s = SQ[me.pos];
      a += B('buy', `Купить за ${gold(s.price)}`, 'class="main"', me.money < s.price) + B('auction', 'На аукцион');
    }
    if (my && S.phase === 'end') a += B('end', 'Завершить ход', 'class="main"', me.money < 0);
    if (me && me.money < 0 && !me.bankrupt)
      a += `<p class="warn">Долг ${gold(-me.money)}: заложите улицы, продайте дома или обменяйтесь</p>` + B('bankrupt', 'Объявить банкротство');

    if (S.auction) {
      const A = S.auction, s = SQ[A.i];
      a += `<div class="box2"><b>Аукцион: ${esc(s.name)}</b> <span class="mut">(цена ${gold(s.price)})</span><br>
        Ставка <b class="good">${gold(A.bid)}</b> ${A.bidder ? esc(pl(A.bidder).name) : ''} · <span id="aucT"></span><div>
        ${[1, 10, 50, 100].map(v => B('bid', '+' + v, `data-v="${A.bid + v}"`, !me || me.bankrupt || A.bidder === ID || me.money < A.bid + v)).join('')}</div></div>`;
    }
    if (S.trade) {
      const T = S.trade, list = (ids, m) => [...ids.map(i => esc(short(SQ[i].name))), ...(m ? [gold(m)] : [])].join(', ') || 'ничего';
      a += `<div class="box2"><b>Обмен: ${esc(pl(T.from).name)} → ${esc(pl(T.to).name)}</b><br>
        Отдаёт: ${list(T.give, T.gm)}<br>Просит: ${list(T.get, T.tm)}<div>
        ${T.to === ID ? B('tradeAns', 'Принять', 'class="main" data-v="1"') + B('tradeAns', 'Отклонить', 'data-v="0"') : ''}
        ${T.from === ID ? B('tradeCancel', 'Отменить') : ''}</div></div>`;
    }
    if (!t.online && t.id !== ID && me && !me.bankrupt) a += B('kick', `${esc(t.name)} не в сети — исключить`, `data-id="${t.id}"`);
    if (me && !me.bankrupt) a += `<div class="row">${B('ui-trade', 'Обмен')}${B('ui-quit', 'Сдаться')}</div>`;
  }
  $('#status').innerHTML = st;
  $('#acts').innerHTML = a;
  const c = S.card;
  $('#cardbox').innerHTML = c && S.phase !== 'over'
    ? `<div class="cardmini ${c.g > 0 ? 'good' : c.g < 0 ? 'bad' : ''}">${c.deck === 'chance' ? 'Шанс' : 'Казна'} · ${esc(pl(c.who)?.name || '')}: ${esc(c.text)}</div>` : '';
  tickAuction();
}

function tickAuction() {
  const el = $('#aucT');
  if (el) el.textContent = Math.max(0, Math.ceil((aucEnd - Date.now()) / 1000)) + ' с';
}
setInterval(tickAuction, 250);

function renderSide() {
  $('#players').innerHTML = S.players.map((p, k) => `
    <div class="pl${S.started && k === S.turn ? ' on' : ''}${p.bankrupt ? ' out' : ''}">
      <span class="m${p.money < 0 ? ' neg' : ''}">${gold(p.money)}</span>
      <i class="dot" style="background:${p.color}"></i><b>${esc(p.name)}</b>${p.id === ID ? ' <span class="mut">(вы)</span>' : ''}
      <div class="tags">${p.jail ? '🔒 в тюрьме ' : ''}${p.jailCards.length ? '🎫 ×' + p.jailCards.length + ' ' : ''}${!p.online ? 'не в сети ' : ''}${p.bankrupt ? 'банкрот' : ''}</div>
      <div class="chips">${Object.entries(S.props).filter(([, x]) => x.owner === p.id).map(([i, x]) =>
        `<i data-a="ui-prop" data-i="${i}" title="${esc(SQ[i].name)}" class="${x.mort ? 'mort' : ''}" style="background:${SQ[i].group ? GROUPS[SQ[i].group].c : '#8a8f99'}"></i>`).join('')}</div>
    </div>`).join('');
  $('#log').innerHTML = S.log.slice().reverse().map(l => `<div>${esc(l)}</div>`).join('');
}

// ---------- окна ----------
function openModal(fn, live) { modal = { fn, live }; drawModal(); }
function drawModal() { $('#modal').innerHTML = `<div class="box">${B('ui-close', '×', 'class="x"')}${modal.fn()}</div>`; $('#modal').hidden = false; }
function closeModal() { modal = null; $('#modal').hidden = true; }
$('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };

const DESC = {
  go: 'Проходя СТАРТ, получаете 200 г золота.', jail: 'Просто в гостях — или отбываете срок.',
  parking: 'Отдых на берегу. Ничего не происходит.', gotojail: 'Отправляйтесь прямо в тюрьму.',
  chance: 'Возьмите карточку «Шанс».', chest: 'Возьмите карточку «Казна».',
};

function openProp(i) {
  openModal(() => {
    const s = SQ[i], pr = S?.props[i], o = pr && pl(pr.owner), mine = o && o.id === ID && !o.bankrupt;
    let h = `<div class="pc" style="--g:${s.group ? GROUPS[s.group].c : 'transparent'}"><h3>${esc(s.name)}</h3>`;
    if (s.type === 'street')
      h += `<table>${['Аренда', '1 дом', '2 дома', '3 дома', '4 дома', 'Отель'].map((l, k) =>
        `<tr${pr && pr.houses === k ? ' class="cur"' : ''}><td>${l}</td><td>${gold(s.rent[k])}</td></tr>`).join('')}</table>
        <p class="mut">Монополия удваивает аренду без домов. Дом стоит ${gold(s.house)}.</p>`;
    else if (s.type === 'rail') h += '<p>Аренда: 25 / 50 / 100 / 200 г за 1–4 транспортных узла.</p>';
    else if (s.type === 'util') h += '<p>Аренда: 4× сумма кубиков, если оба предприятия ваши — 10×.</p>';
    else if (s.type === 'tax') h += `<p>Заплатите ${gold(s.amount)}.</p>`;
    else h += `<p>${DESC[s.type]}</p>`;
    if (s.price) h += `<p>Цена ${gold(s.price)} · залог ${gold(s.price / 2)}</p><p>Владелец: ${o ? esc(o.name) : 'банк'}${pr?.mort ? ' (в залоге)' : ''}</p>`;
    if (mine) h += `<div>${s.type === 'street' ? B('build', 'Построить', `data-i="${i}"`) + B('sell', 'Продать дом', `data-i="${i}"`) : ''}
      ${pr.mort ? B('unmort', `Выкупить за ${gold(Math.ceil(s.price * 0.55))}`, `data-i="${i}"`) : B('mort', 'Заложить', `data-i="${i}"`)}</div>`;
    return h + '</div>';
  }, true);
}

function openTrade(to) {
  if (!to) return openModal(() => `<h3>Обмен с кем?</h3>` + S.players.filter(p => p.id !== ID && !p.bankrupt)
    .map(p => B('ui-trade', `<i class="dot" style="background:${p.color}"></i>${esc(p.name)}`, `data-id="${p.id}"`)).join(''));
  const list = id => Object.entries(S.props).filter(([i, x]) => x.owner === id && !built(+i))
    .map(([i]) => `<label><input type="checkbox" value="${i}"> ${esc(short(SQ[i].name))}</label>`).join('') || '<p class="mut">нечего</p>';
  openModal(() => `<h3>Обмен с ${esc(pl(to).name)}</h3><div class="tr">
    <div id="tgive"><b>Вы отдаёте</b>${list(ID)}<input id="tgm" type="number" min="0" placeholder="золото, г"></div>
    <div id="tget"><b>Вы получаете</b>${list(to)}<input id="ttm" type="number" min="0" placeholder="золото, г"></div></div>
    ${B('ui-send', 'Предложить', `class="main" data-id="${to}"`)}`);
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  const a = b.dataset.a, d = b.dataset;
  if (a === 'ui-close') return closeModal();
  if (a === 'ui-prop') return openProp(+d.i);
  if (a === 'ui-trade') return openTrade(d.id);
  if (a === 'ui-copy') return navigator.clipboard?.writeText(location.href).then(() => float('Ссылка скопирована', 'good'));
  if (a === 'ui-quit') { if (confirm('Сдаться? Ваше имущество уйдёт банку или кредитору.')) send('bankrupt'); return; }
  if (a === 'ui-send') {
    const ids = q => [...document.querySelectorAll(q + ' input:checked')].map(x => +x.value);
    send('trade', { id: d.id, give: ids('#tgive'), get: ids('#tget'), gm: $('#tgm').value, tm: $('#ttm').value });
    return closeModal();
  }
  send(a, { i: +d.i, v: +d.v, id: d.id, ok: d.v === '1' });
});

// ---------- эффекты ----------
const layer = $('#fx');
function add(html, ms) {
  const t = document.createElement('div');
  t.innerHTML = html;
  const e = t.firstElementChild;
  layer.append(e);
  setTimeout(() => e.remove(), ms);
  return e;
}
const banner = (html, cls = '', color = '#f5c542', ms = 1800) =>
  add(`<div class="banner ${cls}" style="--c:${color};--d:${ms - 400}ms">${html}</div>`, ms);
const float = (html, cls = '') => add(`<div class="float ${cls}" style="top:${38 + Math.random() * 14}%">${html}</div>`, 1700);
const flash = cls => add(`<div class="flash ${cls}"></div>`, 800);
function shake() { document.body.classList.remove('shake'); void document.body.offsetWidth; document.body.classList.add('shake'); }
function particles(n, colors, cls) {
  for (let k = 0; k < n; k++)
    add(`<i class="${cls}" style="left:${Math.random() * 100}%;background:${colors[k % colors.length]};--dx:${(Math.random() - 0.5) * 30}vw;--r:${Math.random() * 1080}deg;animation-duration:${1.6 + Math.random() * 1.6}s;animation-delay:${Math.random() * 0.5}s"></i>`, 4000);
}
const confetti = (colors, n = 90) => particles(n, colors, 'cf');
const coins = (n = 26) => particles(n, ['#f5c542', '#e0a800', '#ffe08a'], 'coin');

function rollDice(d) {
  rolling = true;
  const el = $('#dice');
  el.classList.add('rolling');
  let k = 0;
  const t = setInterval(() => {
    el.innerHTML = die(1 + Math.floor(Math.random() * 6)) + die(1 + Math.floor(Math.random() * 6));
    if (++k < 9) return;
    clearInterval(t);
    rolling = false;
    el.classList.remove('rolling');
    el.innerHTML = die(d[0]) + die(d[1]);
    if (d[0] === d[1]) float('ДУБЛЬ!', 'good');
  }, 70);
}

function onFx(e) {
  if (!S) return;
  const who = pl(e.who), nm = who ? esc(who.name) : '', mine = e.who === ID;
  switch (e.t) {
    case 'dice': rollDice(e.d); moveAt = Date.now() + 700; break;
    case 'turn': banner(mine ? 'Ваш ход!' : `Ходит ${nm}`, 'turn', who?.color, 1500); break;
    case 'card':
      setTimeout(() => {
        const el = add(`<div class="card ${e.g > 0 ? 'good' : e.g < 0 ? 'bad' : ''}"><b>${e.deck === 'chance' ? 'ШАНС' : 'КАЗНА'} · ${nm}</b>${esc(e.text)}</div>`, 3400);
        el.onclick = () => el.remove();
        if (e.g < 0) { shake(); flash('bad'); }
        if (e.g > 0) { coins(); flash('good'); }
      }, 1100);
      break;
    case 'mono': {
      const g = GROUPS[e.group];
      setTimeout(() => {
        banner(`МОНОПОЛИЯ!<small>${nm} · ${g.n} группа</small>`, 'mono', g.c, 2800);
        confetti([g.c, '#f5c542', '#ffffff']); flash('good');
      }, 400);
      break;
    }
    case 'jail': setTimeout(() => { add('<div class="bars"></div>', 1900); banner(`${nm} — в тюрьму!`, 'bad'); if (mine) shake(); }, 900); break;
    case 'go': setTimeout(() => { float(`${nm}: +200 г за СТАРТ`, 'good'); if (mine) coins(14); }, 600); break;
    case 'rent': setTimeout(() => { float(`${nm} → ${esc(pl(e.to).name)}: ${gold(e.amount)}`, mine ? 'bad' : e.to === ID ? 'good' : ''); if (mine) flash('bad'); if (e.to === ID) coins(12); }, 1000); break;
    case 'tax': setTimeout(() => { float(`${nm}: налог −${gold(e.amount)}`, 'bad'); if (mine) flash('bad'); }, 1000); break;
    case 'buy': setTimeout(() => cells[e.i].animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)', boxShadow: `0 0 24px ${who.color}` }, { transform: 'scale(1)' }], { duration: 600 }), 300); break;
    case 'build':
      cells[e.i].animate([{ filter: 'brightness(1)' }, { filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 700 });
      if (e.hotel) { float(`${nm} строит отель!`, 'good'); coins(16); }
      break;
    case 'trade': float('Обмен состоялся', 'good'); break;
    case 'bankrupt':
      banner(`${nm} — банкрот`, 'bad', '#ff5a5f', 2200);
      document.body.classList.add('gray'); setTimeout(() => document.body.classList.remove('gray'), 1200);
      break;
    case 'win': banner(`🏆 ${nm} побеждает!`, 'mono', '#f5c542', 6000); confetti(['#f5c542', '#ffffff', '#e63946', '#2ec4b6'], 160); break;
  }
}
