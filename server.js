const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { SQ, CARDS } = require('./public/board.js');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

const rooms = {}, timers = {};
const COLORS = ['#e63946', '#2ec4b6', '#ff9f1c', '#9b5de5', '#3a86ff', '#ff70a6'];
const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const code = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[rnd(32)]).join('');

const P = (r, id) => r.players.find(p => p.id === id);
const cur = r => r.players[r.turn];
const alive = r => r.players.filter(p => !p.bankrupt);
const group = g => SQ.flatMap((s, i) => (s.group === g ? [i] : []));
const hasMono = (r, id, g) => group(g).every(i => r.props[i]?.owner === id);
const count = (r, id, type) => SQ.filter((s, i) => s.type === type && r.props[i]?.owner === id).length;
const groupBuilt = (r, i) => SQ[i].type === 'street' && group(SQ[i].group).some(j => r.props[j]?.houses);

const log = (r, t) => { r.log.push(t); if (r.log.length > 80) r.log.shift(); };
const fx = (r, e) => io.to(r.code).emit('fx', e);
function sync(r) {
  r.last = Date.now();
  const { decks, ...v } = r;
  if (v.auction) v.auction = { ...v.auction, left: v.auction.endsAt - Date.now() };
  io.to(r.code).emit('state', v);
}

function newRoom(code) {
  return {
    code, players: [], hostId: null, started: false, phase: 'lobby', turn: 0,
    dice: [1, 1], doubles: 0, rollAgain: false, special: null, props: {},
    auction: null, trade: null, card: null, winner: null, log: [],
    houses: 32, hotels: 12, last: Date.now(),
    decks: { chance: shuffle([...CARDS.chance.keys()]), chest: shuffle([...CARDS.chest.keys()]) },
  };
}

// ---------- деньги и собственность ----------
function pay(r, p, amt, to) {
  p.money -= amt;
  if (to) to.money += amt;
  if (p.money < 0) p.debtTo = to ? to.id : null;
}

function give(r, i, id) {
  const pr = r.props[i] || (r.props[i] = { houses: 0, mort: false });
  pr.owner = id;
  const s = SQ[i];
  if (s.type === 'street' && hasMono(r, id, s.group)) {
    log(r, `${P(r, id).name} собирает монополию!`);
    fx(r, { t: 'mono', who: id, group: s.group });
  }
}

function rent(r, i, sum) {
  const s = SQ[i], pr = r.props[i];
  if (s.type === 'street') return pr.houses ? s.rent[pr.houses] : s.rent[0] * (hasMono(r, pr.owner, s.group) ? 2 : 1);
  if (s.type === 'rail') return 25 * 2 ** (count(r, pr.owner, 'rail') - 1);
  return sum * (count(r, pr.owner, 'util') === 2 ? 10 : 4);
}

// ---------- движение ----------
function goJail(r, p) {
  p.pos = 10; p.jail = true; p.jailTurns = 0; r.rollAgain = false;
  log(r, `${p.name} отправляется в тюрьму`);
  fx(r, { t: 'jail', who: p.id });
}

function moveTo(r, p, to, passGo = true) {
  if (passGo && to < p.pos) {
    p.money += 200;
    log(r, `${p.name} проходит СТАРТ: +200 г`);
    fx(r, { t: 'go', who: p.id });
  }
  p.pos = to;
  land(r, p);
}

function land(r, p) {
  const i = p.pos, s = SQ[i], pr = r.props[i], sp = r.special;
  r.special = null;
  if (s.price) {
    if (!pr) { r.phase = 'buy'; return; }
    if (pr.owner === p.id || pr.mort) return;
    const o = P(r, pr.owner), sum = r.dice[0] + r.dice[1];
    const amt = sp === 'util' ? sum * 10 : rent(r, i, sum) * (sp === 'rail' ? 2 : 1);
    pay(r, p, amt, o);
    log(r, `${p.name} платит ${o.name} аренду ${amt} г`);
    fx(r, { t: 'rent', who: p.id, to: o.id, amount: amt });
  } else if (s.type === 'tax') {
    pay(r, p, s.amount, null);
    log(r, `${p.name} платит налог ${s.amount} г`);
    fx(r, { t: 'tax', who: p.id, amount: s.amount });
  } else if (s.type === 'chance' || s.type === 'chest') draw(r, p, s.type);
  else if (s.type === 'gotojail') goJail(r, p);
}

function draw(r, p, deck) {
  const k = r.decks[deck].shift(), c = CARDS[deck][k];
  if (c.a === 'free') p.jailCards.push({ deck, k }); else r.decks[deck].push(k);
  r.card = { deck, text: c.t, g: c.g, who: p.id };
  log(r, `${p.name} · ${deck === 'chance' ? 'Шанс' : 'Казна'}: ${c.t}`);
  fx(r, { t: 'card', ...r.card });
  switch (c.a) {
    case 'money': c.v > 0 ? (p.money += c.v) : pay(r, p, -c.v, null); break;
    case 'move': moveTo(r, p, c.to); break;
    case 'back': moveTo(r, p, (p.pos + 40 - c.v) % 40, false); break;
    case 'jail': goJail(r, p); break;
    case 'near': {
      let i = p.pos;
      do i = (i + 1) % 40; while (SQ[i].type !== c.kind);
      r.special = c.kind;
      moveTo(r, p, i);
      break;
    }
    case 'repairs': {
      let sum = 0;
      for (const pr of Object.values(r.props)) if (pr.owner === p.id) sum += pr.houses === 5 ? c.H : pr.houses * c.h;
      pay(r, p, sum, null);
      break;
    }
    case 'each':
      for (const o of alive(r)) if (o !== p) c.v < 0 ? pay(r, p, -c.v, o) : pay(r, o, c.v, p);
      break;
  }
}

function afterLand(r) {
  const p = cur(r);
  r.phase = r.rollAgain && !p.jail ? 'roll' : 'end';
}

function nextTurn(r) {
  r.doubles = 0; r.rollAgain = false; r.card = null;
  do r.turn = (r.turn + 1) % r.players.length; while (cur(r).bankrupt);
  r.phase = 'roll';
  fx(r, { t: 'turn', who: cur(r).id });
}

function checkWin(r) {
  const a = alive(r);
  if (a.length > 1) return false;
  clearTimeout(timers[r.code]);
  r.auction = null; r.trade = null; r.phase = 'over'; r.winner = a[0]?.id;
  if (a[0]) { log(r, `${a[0].name} побеждает!`); fx(r, { t: 'win', who: a[0].id }); }
  return true;
}

function bankrupt(r, p) {
  const cr = p.money < 0 && p.debtTo ? P(r, p.debtTo) : null;
  const mine = Object.entries(r.props).filter(([, pr]) => pr.owner === p.id);
  for (const [i, pr] of mine) if (pr.houses) {
    p.money += pr.houses * SQ[i].house / 2;
    if (pr.houses === 5) r.hotels++; else r.houses += pr.houses;
    pr.houses = 0;
  }
  for (const [i] of mine) cr ? give(r, +i, cr.id) : delete r.props[i];
  if (cr) { cr.money += p.money; cr.jailCards.push(...p.jailCards); }
  else p.jailCards.forEach(c => r.decks[c.deck].push(c.k));
  Object.assign(p, { money: 0, jailCards: [], bankrupt: true, jail: false });
  if (r.trade && (r.trade.from === p.id || r.trade.to === p.id)) r.trade = null;
  if (r.auction?.bidder === p.id) Object.assign(r.auction, { bid: 0, bidder: null });
  log(r, `${p.name} — банкрот${cr ? ', всё имущество уходит ' + cr.name : ''}`);
  fx(r, { t: 'bankrupt', who: p.id });
  if (!checkWin(r) && cur(r) === p) nextTurn(r);
}

// ---------- аукцион ----------
function startAuction(r, i) {
  r.phase = 'auction';
  r.auction = { i, bid: 0, bidder: null, endsAt: Date.now() + 10000 };
  log(r, `Аукцион: ${SQ[i].name}`);
  armAuction(r);
}
function armAuction(r) {
  clearTimeout(timers[r.code]);
  timers[r.code] = setTimeout(() => endAuction(r), r.auction.endsAt - Date.now());
}
function endAuction(r) {
  const a = r.auction;
  if (!a) return;
  r.auction = null;
  const w = a.bidder && P(r, a.bidder);
  if (w && !w.bankrupt && w.money >= a.bid) {
    pay(r, w, a.bid, null);
    log(r, `${w.name} покупает ${SQ[a.i].name} на аукционе за ${a.bid} г`);
    fx(r, { t: 'buy', who: w.id, i: a.i });
    give(r, a.i, w.id);
  } else log(r, `${SQ[a.i].name} никто не купил`);
  if (r.phase === 'auction') afterLand(r);
  sync(r);
}

// ---------- обмен ----------
function tradeOk(r, t) {
  const A = P(r, t.from), B = P(r, t.to);
  if (!A || !B || A.bankrupt || B.bankrupt) return false;
  const ok = (ids, o) => ids.every(i => r.props[i]?.owner === o.id && !groupBuilt(r, i));
  return ok(t.give, A) && ok(t.get, B) && t.gm <= Math.max(0, A.money) && t.tm <= Math.max(0, B.money);
}

// ---------- действия игроков ----------
function act(r, p, a) {
  if (r.phase === 'over') return;
  const me = r.started && cur(r) === p && !p.bankrupt;
  const i = a.i | 0, s = SQ[i] || {}, pr = r.props[i];
  const own = pr && pr.owner === p.id && !p.bankrupt;

  switch (a.t) {
    case 'start':
      if (r.started || p.id !== r.hostId) return;
      if (r.players.length < 2) return 'Нужно минимум 2 игрока';
      r.started = true; r.phase = 'roll'; shuffle(r.players);
      log(r, 'Игра началась! Каждому 1500 г золота');
      fx(r, { t: 'turn', who: cur(r).id });
      return;

    case 'roll': {
      if (!me || r.phase !== 'roll' || r.auction) return;
      const d = (r.dice = [rnd(6) + 1, rnd(6) + 1]), sum = d[0] + d[1], dbl = d[0] === d[1];
      fx(r, { t: 'dice', d, who: p.id });
      log(r, `${p.name} выбрасывает ${d[0]}+${d[1]}`);
      r.phase = 'move';
      if (p.jail) {
        r.rollAgain = false;
        if (dbl) { p.jail = false; log(r, `${p.name} выходит из тюрьмы по дублю`); }
        else if (++p.jailTurns >= 3) { pay(r, p, 50, null); p.jail = false; log(r, `${p.name} отсидел 3 хода, платит 50 г`); }
        else { r.phase = 'end'; return; }
      } else if (dbl && ++r.doubles === 3) {
        log(r, `${p.name}: три дубля подряд!`);
        goJail(r, p); r.phase = 'end'; return;
      } else r.rollAgain = dbl;
      moveTo(r, p, (p.pos + sum) % 40);
      if (r.phase === 'move') afterLand(r);
      return;
    }

    case 'payjail':
      if (!me || r.phase !== 'roll' || !p.jail || p.money < 50) return;
      pay(r, p, 50, null); p.jail = false;
      log(r, `${p.name} платит 50 г и выходит из тюрьмы`);
      return;

    case 'card': {
      if (!me || r.phase !== 'roll' || !p.jail || !p.jailCards.length) return;
      const c = p.jailCards.pop();
      r.decks[c.deck].push(c.k); p.jail = false;
      log(r, `${p.name} использует карту освобождения`);
      return;
    }

    case 'buy': {
      if (!me || r.phase !== 'buy') return;
      const q = SQ[p.pos];
      if (p.money < q.price) return 'Не хватает золота';
      pay(r, p, q.price, null);
      log(r, `${p.name} покупает ${q.name} за ${q.price} г`);
      fx(r, { t: 'buy', who: p.id, i: p.pos });
      give(r, p.pos, p.id);
      afterLand(r);
      return;
    }

    case 'auction':
      if (!me || r.phase !== 'buy') return;
      startAuction(r, p.pos);
      return;

    case 'bid': {
      const A = r.auction, v = a.v | 0;
      if (!A || p.bankrupt || A.bidder === p.id || v <= A.bid || v > p.money) return;
      Object.assign(A, { bid: v, bidder: p.id, endsAt: Date.now() + 7000 });
      armAuction(r);
      return;
    }

    case 'build': {
      if (!own || s.type !== 'street' || !hasMono(r, p.id, s.group)) return;
      const gr = group(s.group).map(j => r.props[j]);
      if (gr.some(x => x.mort)) return 'В группе есть заложенные улицы';
      if (pr.houses >= 5) return;
      if (pr.houses > Math.min(...gr.map(x => x.houses))) return 'Стройте равномерно';
      if (p.money < s.house) return 'Не хватает золота';
      if (pr.houses === 4) { if (!r.hotels) return 'В банке нет отелей'; r.hotels--; r.houses += 4; }
      else { if (!r.houses) return 'В банке нет домов'; r.houses--; }
      pay(r, p, s.house, null); pr.houses++;
      log(r, `${p.name} строит ${pr.houses === 5 ? 'отель' : 'дом'}: ${s.name}`);
      fx(r, { t: 'build', who: p.id, i, hotel: pr.houses === 5 });
      return;
    }

    case 'sell': {
      if (!own || !pr.houses) return;
      const gr = group(s.group).map(j => r.props[j]);
      if (pr.houses < Math.max(...gr.map(x => x.houses))) return 'Продавайте равномерно';
      if (pr.houses === 5) { if (r.houses < 4) return 'В банке не хватает домов, чтобы разобрать отель'; r.hotels++; r.houses -= 4; }
      else r.houses++;
      pr.houses--; p.money += s.house / 2;
      log(r, `${p.name} продаёт постройку: ${s.name}`);
      return;
    }

    case 'mort':
      if (!own || pr.mort) return;
      if (groupBuilt(r, i)) return 'Сначала продайте дома в этой группе';
      pr.mort = true; p.money += s.price / 2;
      log(r, `${p.name} закладывает ${s.name}`);
      return;

    case 'unmort': {
      if (!own || !pr.mort) return;
      const c = Math.ceil(s.price * 0.55);
      if (p.money < c) return 'Не хватает золота';
      pay(r, p, c, null); pr.mort = false;
      log(r, `${p.name} выкупает ${s.name}`);
      return;
    }

    case 'end':
      if (!me || r.phase !== 'end') return;
      if (p.money < 0) return 'Сначала погасите долг';
      nextTurn(r);
      return;

    case 'bankrupt':
      if (r.started && !p.bankrupt) bankrupt(r, p);
      return;

    case 'kick': {
      const t = P(r, a.id);
      if (!r.started || !t || t.online || t.bankrupt || p.bankrupt) return;
      log(r, `${t.name} исключён (не в сети)`);
      bankrupt(r, t);
      return;
    }

    case 'trade': {
      if (!r.started || p.bankrupt) return;
      if (r.trade) return 'Уже идёт другой обмен';
      const ids = x => [...new Set((Array.isArray(x) ? x : []).map(n => n | 0))].filter(n => SQ[n]?.price);
      const gold = x => Math.max(0, Math.floor(+x || 0));
      const t = { from: p.id, to: String(a.id), give: ids(a.give), get: ids(a.get), gm: gold(a.gm), tm: gold(a.tm) };
      if (t.to === p.id || !(t.give.length + t.get.length + t.gm + t.tm)) return;
      if (!tradeOk(r, t)) return 'Такой обмен невозможен';
      r.trade = t;
      log(r, `${p.name} предлагает обмен игроку ${P(r, t.to).name}`);
      return;
    }

    case 'tradeAns': {
      const t = r.trade;
      if (!t || t.to !== p.id) return;
      r.trade = null;
      if (!a.ok) { log(r, `${p.name} отклоняет обмен`); return; }
      if (!tradeOk(r, t)) return 'Условия обмена уже невыполнимы';
      const A = P(r, t.from);
      A.money += t.tm - t.gm; p.money += t.gm - t.tm;
      t.give.forEach(j => give(r, j, p.id));
      t.get.forEach(j => give(r, j, A.id));
      log(r, `Обмен ${A.name} ⇄ ${p.name} состоялся`);
      fx(r, { t: 'trade' });
      return;
    }

    case 'tradeCancel':
      if (r.trade?.from === p.id) r.trade = null;
      return;
  }
}

// ---------- сокеты ----------
io.on('connection', s => {
  s.on('join', ({ room, name, id } = {}) => {
    room = String(room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    name = String(name || '').trim().slice(0, 16) || 'Игрок';
    id = String(id || '').slice(0, 40);
    if (!id) return;
    if (!room) do room = code(); while (rooms[room]);
    const r = rooms[room] || (rooms[room] = newRoom(room));
    let p = P(r, id);
    if (!p) {
      if (r.started) return s.emit('err', 'Игра в этой комнате уже идёт');
      if (r.players.length >= 6) return s.emit('err', 'Комната заполнена');
      const color = COLORS.find(c => !r.players.some(x => x.color === c));
      p = { id, name, color, pos: 0, money: 1500, jail: false, jailTurns: 0, jailCards: [], bankrupt: false, online: true, debtTo: null };
      r.players.push(p);
      r.hostId ||= id;
      log(r, `${name} заходит в комнату`);
    }
    p.online = true; p.sock = s.id;
    s.data = { room, id };
    s.join(room);
    s.emit('joined', { room });
    sync(r);
  });

  s.on('act', a => {
    const r = rooms[s.data.room], p = r && P(r, s.data.id);
    if (!p || !a || typeof a !== 'object') return;
    const e = act(r, p, a);
    if (e) s.emit('err', e);
    sync(r);
  });

  s.on('disconnect', () => {
    const r = rooms[s.data.room], p = r && P(r, s.data.id);
    if (!p || p.sock !== s.id) return;
    if (!r.started) {
      r.players = r.players.filter(x => x !== p);
      if (r.hostId === p.id) r.hostId = r.players[0]?.id || null;
      if (!r.players.length) { delete rooms[r.code]; return; }
    } else p.online = false;
    sync(r);
  });
});

// Пустые комнаты удаляем через 2 часа простоя
setInterval(() => {
  for (const r of Object.values(rooms))
    if (!r.players.some(p => p.online) && Date.now() - r.last > 2 * 3600e3) { clearTimeout(timers[r.code]); delete rooms[r.code]; }
}, 10 * 60e3);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Монополия: http://localhost:${PORT}`));
