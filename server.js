const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const cards = [
  { name: 'Small appetite', values: [0, 24, 44, 51, 56, 40, 36], color: 'mint' },
  { name: 'Medium appetite', values: [0, 8, 28, 57, 80, 80, 54], color: 'blue' },
  { name: 'Large appetite', values: [0, 8, 18, 36, 56, 90, 120], color: 'coral' }
];
const PRICE = 10;
// Buyer-best-response check: Single q=4 gives seller 40.0, buyer 24.0 and 75% value captured;
// Menu min=4 yields q=[4,4,6], seller 46.7, buyer 38.7 and 100%; Single q=6 seller avg is 20.0.
const phrases = ['Sounds good 👍', 'Hmm… tempting 🤔', 'That’s too much 😅', 'Let’s make a deal 🤝', 'I’m hungry! 😋', 'No deal 🙅'];
const id = () => crypto.randomBytes(8).toString('hex');
const code = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const shuffle = list => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
function freshRoom(hostId, hostName) {
  return {
    code: code(), hostId,
    players: [{ id: hostId, name: hostName, score: 0, connected: true, lastSeen: Date.now(), lastRole: null, rotation: { buyer: 0, seller: 0, sitOut: 0 } }],
    settings: { mode: 'menu', chat: true, odd: 'sit', lateJoin: false },
    round: 0, roundSitter: null, practiceDone: false, started: false, phase: 'lobby', step: null, deadline: 0, botLastRole: null,
    pairs: [], history: [], offers: {}, messages: {}, endAt: 0
  };
}
function pairDone(room, pair) { return room.history.some(h => h.round === room.round && h.a === pair.a); }
function settle(room, pair, quantity, { veto = false, reason = null } = {}) {
  if (!pair || pairDone(room, pair)) return;
  const q = veto ? 0 : Math.max(0, Math.min(6, quantity));
  const buyerId = pair.roleA === 'Buyer' ? pair.a : pair.b;
  const sellerId = buyerId === pair.a ? pair.b : pair.a;
  const buyer = room.players.find(p => p.id === buyerId);
  const seller = room.players.find(p => p.id === sellerId);
  const noDeal = veto || q === 0;
  const buyerCoins = noDeal ? 0 : pair.card.values[q] - PRICE * q;
  const sellerCoins = noDeal ? 0 : PRICE * q;
  const offer = room.offers[pair.a];
  let bestBuyerCoins = -Infinity;
  if (offer) {
    const start = offer.mode === 'menu' ? offer.quantity : offer.quantity;
    const end = offer.mode === 'menu' ? 6 : offer.quantity;
    for (let n = start; n <= end; n++) bestBuyerCoins = Math.max(bestBuyerCoins, pair.card.values[n] - PRICE * n);
  }
  const bestValue = Math.max(...pair.card.values);
  const actualValue = noDeal ? 0 : pair.card.values[q];
  const spiteVeto = veto && bestBuyerCoins > 0;
  if (!room.practice) {
    if (buyer) buyer.score += buyerCoins;
    if (seller) seller.score += sellerCoins;
  }
  room.history.push({
    round: room.round, a: pair.a, b: pair.b, buyer: buyerId, seller: sellerId,
    cardName: pair.card.name, values: pair.card.values, quantity: noDeal ? 0 : q,
    offerQuantity: offer?.quantity ?? null, mode: offer?.mode || room.settings.mode,
    veto, noDeal, buyerCoins, sellerCoins, bestValue, actualValue, spiteVeto,
    capturedPct: bestValue ? actualValue / bestValue * 100 : 0,
    table: Math.max(0, bestValue - actualValue), practice: !!room.practice, reason
  });
  if (room.pairs.length && room.pairs.every(p => pairDone(room, p))) room.phase = 'reveal';
}
function makeOffer(room, pair, playerId, quantity) {
  room.offers[pair.a] = { pair: pair.a, quantity, mode: room.settings.mode, by: playerId };
  const buyerId = pair.roleA === 'Buyer' ? pair.a : pair.b;
  if (buyerId !== 'bot') return;
  const offer = room.offers[pair.a];
  const min = offer.mode === 'menu' ? offer.quantity : offer.quantity;
  const max = offer.mode === 'menu' ? 6 : offer.quantity;
  let bestQ = min, bestNet = pair.card.values[min] - PRICE * min;
  for (let q = min + 1; q <= max; q++) {
    const net = pair.card.values[q] - PRICE * q;
    if (net > bestNet) { bestQ = q; bestNet = net; }
  }
  const veto = bestNet < 0;
  settle(room, pair, bestQ, { veto, reason: veto ? 'bot_veto' : null });
}
function startRound(room, practice = false) {
  room.roundSitter = null;
  let active = shuffle(room.players.filter(p => p.connected));
  if (active.length < 2) return false;
  if (active.length % 2) {
    if (room.settings.odd === 'bot') {
      active.push({ id: 'bot', name: 'Miso 🤖', score: 0, connected: true, lastRole: room.botLastRole, rotation: { buyer: 0, seller: 0, sitOut: 0 } });
    } else {
      const least = Math.min(...active.map(p => p.rotation?.sitOut || 0));
      const tied = active.filter(p => (p.rotation?.sitOut || 0) === least);
      const sitting = tied[crypto.randomInt(tied.length)];
      active = active.filter(p => p.id !== sitting.id);
      sitting.rotation ||= { buyer: 0, seller: 0, sitOut: 0 };
      sitting.rotation.sitOut++;
      room.roundSitter = sitting.id;
    }
  }
  room.round++;
  room.practice = practice;
  const sellers = [], buyers = [], unknown = [];
  for (const player of active) {
    if (player.lastRole === 'Seller') buyers.push(player);
    else if (player.lastRole === 'Buyer') sellers.push(player);
    else unknown.push(player);
  }
  for (const player of shuffle(unknown)) (sellers.length <= buyers.length ? sellers : buyers).push(player);
  // If a changing roster makes exact alternation unbalance the two role pools, flip only as many roles as needed.
  while (sellers.length > buyers.length) buyers.push(sellers.pop());
  while (buyers.length > sellers.length) sellers.push(buyers.pop());
  for (const player of sellers) {
    player.lastRole = 'Seller';
    if (player.id !== 'bot') { player.rotation ||= { buyer: 0, seller: 0, sitOut: 0 }; player.rotation.seller++; }
    else room.botLastRole = 'Seller';
  }
  for (const player of buyers) {
    player.lastRole = 'Buyer';
    if (player.id !== 'bot') { player.rotation ||= { buyer: 0, seller: 0, sitOut: 0 }; player.rotation.buyer++; }
    else room.botLastRole = 'Buyer';
  }
  const shuffledSellers = shuffle(sellers), shuffledBuyers = shuffle(buyers);
  room.pairs = shuffledSellers.map((seller, i) => {
    const buyer = shuffledBuyers[i];
    const card = cards[crypto.randomInt(cards.length)];
    return { a: seller.id, b: buyer.id, roleA: 'Seller', roleB: 'Buyer', card, cardType: cards.indexOf(card) };
  });
  room.phase = 'trade'; room.step = 'offer'; room.deadline = Date.now() + 30000;
  room.offers = {}; room.messages = {};
  room.started = true;
  for (const pair of room.pairs) {
    if (pair.a === 'bot') makeOffer(room, pair, 'bot', 4); // Seller bot offers 4 in either offer mode.
  }
  return true;
}
function advanceTime(room) {
  if (room.phase === 'ended' && Date.now() >= room.endAt) { rooms.delete(room.code); return; }
  if (room.phase !== 'trade') return;
  const sellersFinished = room.step === 'offer' && room.pairs.every(p => pairDone(room, p) || room.offers[p.a]);
  if (Date.now() < room.deadline && !sellersFinished) return;
  if (room.step === 'offer') {
    for (const pair of room.pairs) {
      if (!pairDone(room, pair) && !room.offers[pair.a]) settle(room, pair, 0, { veto: true, reason: 'seller_timeout' });
    }
    if (room.phase !== 'trade') return;
    room.step = 'respond'; room.deadline = Date.now() + 20000;
  } else if (room.step === 'respond') {
    for (const pair of room.pairs) if (!pairDone(room, pair)) settle(room, pair, 0, { veto: true, reason: 'buyer_timeout' });
  }
}
function pub(room, pid) {
  const mine = room.pairs.find(p => p.a === pid || p.b === pid);
  const role = mine ? (mine.a === pid ? mine.roleA : mine.roleB) : null;
  const visibleHistory = room.history.filter(h => h.round !== room.round || room.phase === 'reveal' || room.phase === 'ended');
  const realHistory = room.history.filter(h => !h.practice);
  const efficiency = realHistory.reduce((sum, h) => ({ actual: sum.actual + h.actualValue, best: sum.best + h.bestValue }), { actual: 0, best: 0 });
  return {
    code: room.code, hostId: room.hostId,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: room.phase === 'ended' ? p.score : p.id === pid ? p.score : null, connected: p.connected, role: room.pairs.find(x => x.a === p.id || x.b === p.id)?.[room.pairs.find(x => x.a === p.id || x.b === p.id).a === p.id ? 'roleA' : 'roleB'] || null, rotation: p.rotation, sittingOut: p.id === room.roundSitter })),
    settings: room.settings, round: room.round, practice: !!room.practice, practiceDone: room.practiceDone,
    started: room.started, phase: room.phase, step: room.step,
    remainingMs: room.phase === 'trade' ? Math.max(0, room.deadline - Date.now()) : 0,
    yourRole: role, yourCard: role === 'Buyer' ? { name: mine.card.name, values: mine.card.values, color: mine.card.color } : null,
    yourPair: mine ? mine.a : null, history: visibleHistory, efficiency,
    offer: mine ? room.offers[mine.a] || null : null,
    messages: mine ? room.messages[mine.a] || [] : [], yourId: pid
  };
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function fail(res, status, message) { json(res, status, { error: message }); }

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
  req.on('end', () => {
    let data = {}; try { data = body ? JSON.parse(body) : {}; } catch {}
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'create') {
      const hostId = id(), room = freshRoom(hostId, String(data.name || 'Host').trim().slice(0, 18) || 'Host');
      rooms.set(room.code, room); return json(res, 200, { code: room.code, id: hostId });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'join') {
      const room = rooms.get(String(data.code || '').toUpperCase());
      if (!room) return fail(res, 404, 'Room not found. Check the code and try again.');
      let player = room.players.find(p => p.id === data.id);
      if (!player && room.started && !room.settings.lateJoin) return fail(res, 403, 'This game has already started. Ask the host to open a new room.');
      if (!player) {
        player = { id: id(), name: String(data.name || 'Player').trim().slice(0, 18) || 'Player', score: 0, connected: true, lastSeen: Date.now(), lastRole: null, rotation: { buyer: 0, seller: 0, sitOut: 0 } };
        room.players.push(player);
      }
      player.connected = true; player.lastSeen = Date.now();
      return json(res, 200, { code: room.code, id: player.id });
    }
    if (parts[0] !== 'api' || !parts[1]) return fail(res, 404, 'Not found');
    const room = rooms.get(parts[1].toUpperCase());
    if (!room) return fail(res, 404, 'Room not found');
    const pid = data.id || url.searchParams.get('id');
    if (req.method === 'GET' && parts[2] === 'state') {
      advanceTime(room);
      if (!rooms.has(room.code)) return fail(res, 404, 'Room not found');
      const player = room.players.find(p => p.id === pid);
      if (player) { player.lastSeen = Date.now(); player.connected = true; }
      for (const p of room.players) if (Date.now() - p.lastSeen > 10000) p.connected = false;
      return json(res, 200, pub(room, pid));
    }
    const player = room.players.find(p => p.id === pid);
    if (!player) return fail(res, 403, 'Join the room first.');
    advanceTime(room);
    if (parts[2] === 'leave' && req.method === 'POST') {
      player.connected = false; player.lastSeen = 0;
      return json(res, 200, { ok: true });
    }
    if (parts[2] === 'settings' && req.method === 'POST' && pid === room.hostId && room.phase !== 'trade') {
      const allowed = ['mode', 'chat', 'odd', 'lateJoin'];
      for (const key of allowed) if (key in (data.settings || {})) room.settings[key] = data.settings[key];
    }
    if (parts[2] === 'start' && req.method === 'POST' && pid === room.hostId && room.phase === 'lobby') {
      const practice = !!data.practice;
      if (startRound(room, practice) && practice) room.practiceDone = false;
    }
    if (parts[2] === 'offer' && req.method === 'POST' && room.phase === 'trade' && room.step === 'offer') {
      const pair = room.pairs.find(p => (p.a === pid || p.b === pid) && (p.roleA === 'Seller' ? p.a === pid : p.b === pid));
      if (pair && !pairDone(room, pair)) makeOffer(room, pair, pid, Math.max(0, Math.min(6, Number(data.quantity) || 0)));
    }
    if (parts[2] === 'respond' && req.method === 'POST' && room.phase === 'trade' && room.step === 'respond') {
      const pair = room.pairs.find(p => (p.a === pid || p.b === pid) && (p.roleA === 'Buyer' ? p.a === pid : p.b === pid));
      const offer = pair && room.offers[pair.a];
      if (pair && offer && !pairDone(room, pair)) {
        const veto = !!data.veto;
        const quantity = room.settings.mode === 'menu' ? Math.max(offer.quantity, Math.min(6, Number(data.quantity) || offer.quantity)) : offer.quantity;
        settle(room, pair, quantity, { veto });
      }
    }
    if (parts[2] === 'message' && req.method === 'POST' && room.settings.chat && room.phase === 'trade' && phrases.includes(data.text)) {
      const pair = room.pairs.find(p => p.a === pid || p.b === pid);
      if (pair && !pairDone(room, pair)) {
        const thread = room.messages[pair.a] || (room.messages[pair.a] = []);
        thread.push({ id: pid, text: data.text });
        if (thread.length > 30) thread.shift();
      }
    }
    if (parts[2] === 'next' && req.method === 'POST' && pid === room.hostId && room.phase === 'reveal') {
      if (room.practice) room.practiceDone = true;
      startRound(room, false);
    }
    if (parts[2] === 'reset' && req.method === 'POST' && pid === room.hostId && room.phase !== 'trade') {
      for (const p of room.players) { p.score = 0; p.lastRole = null; p.rotation = { buyer: 0, seller: 0, sitOut: 0 }; }
      room.history = []; room.round = 0; room.practiceDone = false; room.started = false; room.botLastRole = null;
      room.practice = false; room.phase = 'lobby'; room.roundSitter = null; room.step = null; room.pairs = []; room.offers = {}; room.messages = {};
    }
    if (parts[2] === 'end' && req.method === 'POST' && pid === room.hostId) {
      if (room.phase === 'trade') for (const pair of room.pairs) if (!pairDone(room, pair)) settle(room, pair, 0, { veto: true, reason: 'game_ended' });
      room.phase = 'ended'; room.endAt = Date.now() + 30000;
      const endingCode = room.code;
      setTimeout(() => rooms.delete(endingCode), 30000).unref?.();
    }
    return json(res, 200, pub(room, pid));
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Hidden Appetite is running on http://localhost:${PORT}`));

