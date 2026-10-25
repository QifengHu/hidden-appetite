const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
const cards = [
  { name: 'Small appetite', values: [0, 28, 50, 54, 52, 42, 30], color: 'mint' },
  { name: 'Medium appetite', values: [0, 5, 35, 70, 95, 85, 50], color: 'blue' },
  { name: 'Large appetite', values: [0, 5, 17, 45, 75, 110, 140], color: 'coral' }
];
const PRICE = 10;
// Buyer-best-response check: Single q=4: kitchen 40.0, customer 34.0, 77% value captured.
// Menu min=4: choices [4,4,6], kitchen 46.7, customer 49.0, 99% value captured.
// Single q=6: Small and Medium veto, kitchen avg 20.0.
const phrases = {
  Kitchen: ["Big portions today! 🍲", "Chef's special: a big plate! 🤌", "Trust me, you'll want more 😋", "That's my best offer 🤝", "Busy night — take it or leave it ⏰", "I can go lower… maybe 🤔", "Don't walk away hungry 🥺", "Everyone's ordering big today 📈"],
  Customer: ["I'm barely hungry 🙂", "Just a snack for me 🥨", "I'm STARVING 🤤", "That's way too much 😅", "Make it smaller and we have a deal 🤝", "I'll walk away if I have to 🚶", "Sounds tasty 👍", "Hmm… let me think 🤔"],
  Shared: ['😂', '👀', '🙏', '😤']
};
const customerSignals = [
  { text: 'Just a snack for me 🥨', kind: 'small' },
  { text: 'A normal meal 🍽️', kind: 'medium' },
  { text: "I'm STARVING 🤤", kind: 'large' },
  { text: 'Not telling 🤐', kind: 'secret' }
];const id = () => crypto.randomBytes(8).toString('hex');
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
    settings: { mode: 'menu', gamePlan: 'rotate', cycles: 4, chat: true, customerSpeaksFirst: true, odd: 'bot', lateJoin: true },
    round: 0, realRound: 0, block: 0, blockRound: 0, roundSitter: null, practiceDone: false, started: false, phase: 'lobby', step: null, deadline: 0, transitionMode: null, transitionFullRules: false, seenModes: [], botLastRole: null, leaderboardScores: {}, rankChanges: {}, topEarners: [], roundFinalized: false, finalReveal: false, signals: {}, lastActivity: Date.now(),
    pairs: [], history: [], offers: {}, messages: {}, ready: {}
  };
}
function pairDone(room, pair) { return room.history.some(h => h.round === room.round && h.a === pair.a); }
function plannedMode(room, realRound = null) {
  if (room.practice) return room.settings.gamePlan === 'manual' ? room.settings.mode : 'menu';
  if (room.settings.gamePlan === 'manual') return room.settings.mode;
  const first = room.settings.gamePlan === 'menu-first' ? 'menu' : 'single';
  const block = Math.max(1, realRound == null ? room.block : Math.ceil(realRound / 2));
  return (block - 1) % 2 === 0 ? first : first === 'single' ? 'menu' : 'single';
}
function freezeLeaderboard(room) {
  if (room.practice || room.roundFinalized) return;
  const active = room.players.filter(p => p.id !== 'bot');
  const oldOrder = [...active].sort((a,b) => (room.leaderboardScores[b.id] || 0) - (room.leaderboardScores[a.id] || 0));
  const oldRanks = new Map(oldOrder.map((p,i) => [p.id, i + 1]));
  const earnings = new Map(active.map(p => [p.id, 0]));
  for (const h of room.history.filter(h => h.round === room.round && !h.practice)) {
    earnings.set(h.buyer, (earnings.get(h.buyer) || 0) + h.buyerCoins);
    earnings.set(h.seller, (earnings.get(h.seller) || 0) + h.sellerCoins);
  }
  for (const p of active) room.leaderboardScores[p.id] = p.score;
  const ranked = [...active].sort((a,b) => b.score - a.score);
  room.rankChanges = Object.fromEntries(ranked.map((p,i) => [p.id, oldRanks.has(p.id) ? oldRanks.get(p.id) - i - 1 : 0]));
  const maxEarned = Math.max(0, ...earnings.values());
  room.topEarners = maxEarned > 0 ? [...earnings].filter(([,value]) => value === maxEarned).map(([playerId]) => playerId) : [];
  room.roundFinalized = true;
}
function settle(room, pair, quantity, { veto = false, reason = null } = {}) {
  if (!pair || pairDone(room, pair)) return;
  const q = veto ? 0 : Math.max(1, Math.min(6, Number(quantity) || 1));
  const buyerId = pair.roleA === 'Buyer' ? pair.a : pair.b;
  const sellerId = buyerId === pair.a ? pair.b : pair.a;
  const buyer = room.players.find(p => p.id === buyerId);
  const seller = room.players.find(p => p.id === sellerId);
  const noDeal = veto || q === 0;
  const buyerCoins = noDeal ? 0 : pair.card.values[q] - PRICE * q;
  const sellerCoins = noDeal ? 0 : PRICE * q;
  const offer = room.offers[pair.a];
  const signal = room.signals[pair.a] || null;
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
    round: room.round, realRound: room.realRound, block: room.block, blockRound: room.blockRound, a: pair.a, b: pair.b, buyer: buyerId, seller: sellerId,
    cardName: pair.card.name, values: pair.card.values, quantity: noDeal ? 0 : q,
    offerQuantity: offer?.quantity ?? null, mode: offer?.mode || room.settings.mode,
    veto, noDeal, buyerCoins, sellerCoins, bestValue, actualValue, spiteVeto,
    capturedPct: bestValue ? actualValue / bestValue * 100 : 0,
    table: Math.max(0, bestValue - actualValue), practice: !!room.practice, reason, signal: signal?.text || null, signalKind: signal?.kind || null, bluff: !!signal?.bluff
  });
  if (room.pairs.length && room.pairs.every(p => pairDone(room, p))) {
    room.ready = {}; room.phase = 'reveal';
    freezeLeaderboard(room);
    if (!room.practice && room.settings.gamePlan !== 'manual' && room.realRound >= room.settings.cycles * 4) {
      room.ready = {}; room.phase = 'ended'; room.finalReveal = true;
    }
  }
}
function makeOffer(room, pair, playerId, quantity) {
  room.offers[pair.a] = { pair: pair.a, quantity, mode: plannedMode(room) };
  const buyerId = pair.roleA === 'Buyer' ? pair.a : pair.b;
  if (buyerId !== 'bot') return;
  const offer = room.offers[pair.a];
  const signal = room.signals[pair.a] || null;
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
function enterTransition(room, mode) {
  room.ready = {}; room.phase = 'transition'; room.step = null; room.transitionMode = mode;
  room.transitionFullRules = !room.seenModes.includes(mode);
  if (room.transitionFullRules) room.seenModes.push(mode);
  room.deadline = Date.now() + 15000;
}
function startRound(room, practice = false) {
  room.roundSitter = null;
  room.practice = practice;
  room.awayThisRound = room.players.filter(p => !p.connected).length;
  let active = shuffle(room.players.filter(p => p.connected));
  if (active.length === 1) {
    active.push({ id: 'bot', name: 'Miso 🤖', score: 0, connected: true, lastRole: room.botLastRole, rotation: { buyer: 0, seller: 0, sitOut: 0 } });
  }
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
  if (!practice) { room.realRound++; room.block = Math.ceil(room.realRound / 2); room.blockRound = ((room.realRound - 1) % 2) + 1; }
  else { room.block = 0; room.blockRound = 0; }
  room.settings.mode = plannedMode(room); room.transitionMode = null;
  
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
  room.ready = {}; room.phase = 'trade'; room.step = room.settings.customerSpeaksFirst ? 'talk' : 'offer'; room.deadline = Date.now() + (room.step === 'talk' ? (room.practice ? 60000 : 15000) : (room.practice ? 90000 : 30000)); room.roundFinalized = false;
  room.offers = {}; room.messages = {}; room.signals = {};
  room.started = true;
  for (const pair of room.pairs) {
    const buyerId = pair.roleA === 'Buyer' ? pair.a : pair.b;
    if (room.settings.customerSpeaksFirst && buyerId === 'bot') {
      const signal = customerSignals[pair.cardType];
      room.signals[pair.a] = { buyer: 'bot', text: signal.text, kind: signal.kind, bluff: false };
    }
    if (room.step === 'offer' && pair.a === 'bot') makeOffer(room, pair, 'bot', 4);
  }
  if (room.step === 'talk' && room.pairs.filter(p => (p.roleA === 'Buyer' ? p.a : p.b) !== 'bot').every(p => room.signals[p.a])) closeTalk(room);
  return true;
}
function closeTalk(room) {
  room.step = 'offer'; room.deadline = Date.now() + (room.practice ? 90000 : 30000);
  for (const pair of room.pairs) if (pair.a === 'bot' && !pairDone(room,pair)) makeOffer(room,pair,'bot',4);
}
function advanceFromReveal(room) {
  if (room.practice) {
    room.practiceDone = true; room.practice = false; room.realRound = 0; room.block = 0; room.blockRound = 0;
    if (room.settings.gamePlan === 'manual') {
      const nextMode = room.settings.mode, practiceMode = room.history.find(h => h.round === room.round)?.mode || nextMode;
      if (nextMode !== practiceMode) enterTransition(room, nextMode); else startRound(room, false);
    } else enterTransition(room, plannedMode(room, 1));
  } else if (room.settings.gamePlan === 'manual' || room.realRound < room.settings.cycles * 4) {
    const nextMode = plannedMode(room, room.realRound + 1);
    const currentMode = room.practice ? room.settings.mode : (room.history.find(h => h.round === room.round)?.mode || room.settings.mode);
    if (nextMode !== currentMode) enterTransition(room, nextMode);
    else startRound(room, false);
  }
}
function allConnectedHumansReady(room) {
  const players = room.players.filter(p => p.id !== 'bot' && p.connected);
  return players.length > 0 && players.every(p => room.ready?.[p.id]);
}
function advanceIfReady(room) {
  if (!allConnectedHumansReady(room)) return;
  if (room.phase === 'reveal') advanceFromReveal(room);
  else if (room.phase === 'transition') startRound(room, false);
}
function advanceTime(room) {
  if (room.phase === 'reveal' || room.phase === 'transition') advanceIfReady(room);
  if (room.phase === 'transition' && Date.now() >= room.deadline) { startRound(room, false); return; }
  if (room.phase !== 'trade') return;
  if (room.step === 'talk') {
    const buyers = room.pairs.filter(p => p.roleA === 'Buyer' ? p.a !== 'bot' : p.b !== 'bot');
    const allSpoke = buyers.every(p => room.signals[p.a]);
    if (allSpoke || Date.now() >= room.deadline) {
      for (const pair of buyers) if (!room.signals[pair.a]) room.signals[pair.a] = { buyer: pair.roleA === 'Buyer' ? pair.a : pair.b, text: '… (no comment)', kind: 'none', bluff: false };
      closeTalk(room); return;
    }
    return;
  }
  const sellersFinished = room.step === 'offer' && room.pairs.every(p => pairDone(room, p) || room.offers[p.a]);
  if (Date.now() < room.deadline && !sellersFinished) return;
  if (room.step === 'offer') {
    for (const pair of room.pairs) if (!pairDone(room, pair) && !room.offers[pair.a]) settle(room, pair, 0, { veto: true, reason: 'seller_timeout' });
    if (room.phase !== 'trade') return;
    room.step = 'respond'; room.deadline = Date.now() + (room.practice ? 60000 : 20000);
  } else if (room.step === 'respond') {
    for (const pair of room.pairs) if (!pairDone(room, pair)) settle(room, pair, 0, { veto: true, reason: 'buyer_timeout' });
  }
}
function pub(room, pid) {
  const mine = room.pairs.find(p => p.a === pid || p.b === pid);
  const role = mine ? (mine.a === pid ? mine.roleA : mine.roleB) : null;
  const visibleHistory = room.history.filter(h => h.round !== room.round || room.phase === 'reveal' || room.phase === 'transition' || room.phase === 'ended');
  const realHistory = room.history.filter(h => !h.practice);
  const efficiency = realHistory.reduce((sum, h) => ({ actual: sum.actual + h.actualValue, best: sum.best + h.bestValue }), { actual: 0, best: 0 });
  const maxAbsEarnings = Math.max(...cards.flatMap(card => card.values.map((value, q) => Math.abs(value - PRICE * q))));
  const sellerCurves = role === 'Seller' && !room.practice ? cards.map(card => ({ name: card.name.replace(' appetite', ''), shape: card.values.slice(1).map((value, index) => { const q = index + 1; const earnings = value - PRICE * q; const rounded = Number((earnings / maxAbsEarnings).toFixed(1)); return rounded === 0 && earnings < 0 ? -0.1 : rounded; }) })) : null;
  const practiceCards = role === 'Seller' && room.practice ? cards.map(card => ({ name: card.name, values: card.values, color: card.color })) : null;
  const readyPlayers = room.players.filter(p => p.id !== 'bot' && p.connected);
  return {
    code: room.code, hostId: room.hostId, awayThisRound: room.awayThisRound || 0, readiness: { ready: readyPlayers.filter(p => room.ready?.[p.id]).length, total: readyPlayers.length },
    players: room.players.map(p => ({ id: p.id, name: p.name, score: room.leaderboardScores[p.id] || 0, connected: p.connected, ready: !!room.ready?.[p.id], role: room.phase === 'trade' ? null : room.pairs.find(x => x.a === p.id || x.b === p.id)?.[room.pairs.find(x => x.a === p.id || x.b === p.id).a === p.id ? 'roleA' : 'roleB'] || null, rotation: p.rotation, sittingOut: p.id === room.roundSitter })),
    settings: room.settings, round: room.round, realRound: room.realRound, totalRounds: room.settings.cycles * 4, block: room.block, blockRound: room.blockRound, totalBlocks: room.settings.cycles * 2, plannedMode: plannedMode(room), transitionMode: room.transitionMode, transitionFullRules: room.transitionFullRules, transitionSummary: room.history.filter(h => !h.practice && h.block === room.block), transitionPending: room.phase === 'reveal' && (room.practice ? room.settings.gamePlan !== 'manual' : plannedMode(room,room.realRound + 1) !== (room.settings.gamePlan === 'manual' ? (room.history.find(h => h.round === room.round)?.mode || room.settings.mode) : room.settings.mode)), rankChanges: room.rankChanges, topEarners: room.topEarners, finalReveal: room.finalReveal, practice: !!room.practice, practiceDone: room.practiceDone,
    started: room.started, phase: room.phase, step: room.step,
    remainingMs: room.phase === 'trade' ? Math.max(0, room.deadline - Date.now()) : 0,
    yourRole: role, yourCard: role === 'Buyer' ? { name: mine.card.name, values: mine.card.values, color: mine.card.color } : null,
    sellerCurves, practiceCards, talkSignal: mine && (role === 'Buyer' || (role === 'Seller' && room.step !== 'talk')) ? room.signals[mine.a] || null : null, chatPhrases: role ? [...phrases[role === 'Seller' ? 'Kitchen' : 'Customer'], ...phrases.Shared] : [],
    yourPair: mine ? mine.a : null, history: visibleHistory, efficiency,
    offer: mine ? room.offers[mine.a] || null : null,
    messages: mine ? room.messages[mine.a] || [] : [], yourId: pid
  };
}function json(res, status, data) {
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
      if (Date.now() - room.lastActivity >= ROOM_IDLE_MS) { rooms.delete(room.code); return fail(res, 404, 'Room not found.'); }
      room.lastActivity = Date.now();
      let player = room.players.find(p => p.id === data.id);
      let lateJoinWelcome = false;
      if (!player && room.started && !room.settings.lateJoin) return fail(res, 403, 'This game has already started. Ask the host to open a new room.');
      if (!player) {
        lateJoinWelcome = !!room.started;
        player = { id: id(), name: String(data.name || 'Player').trim().slice(0, 18) || 'Player', score: 0, connected: true, lastSeen: Date.now(), lastRole: null, rotation: { buyer: 0, seller: 0, sitOut: 0 } };
        room.players.push(player);
      }
      player.connected = true; player.lastSeen = Date.now();
      return json(res, 200, { code: room.code, id: player.id, lateJoinWelcome });
    }
    if (parts[0] !== 'api' || !parts[1]) return fail(res, 404, 'Not found');
    const room = rooms.get(parts[1].toUpperCase());
    if (!room) return fail(res, 404, 'Room not found');
    if (Date.now() - room.lastActivity >= ROOM_IDLE_MS) { rooms.delete(room.code); return fail(res, 404, 'Room not found'); }
    room.lastActivity = Date.now();
    const pid = data.id || url.searchParams.get('id');
    if (req.method === 'GET' && parts[2] === 'state') {
      if (!rooms.has(room.code)) return fail(res, 404, 'Room not found');
      const player = room.players.find(p => p.id === pid);
      const returnedFromAway = !!player && (!player.connected || Date.now() - player.lastSeen > 60000);
      if (player) { player.lastSeen = Date.now(); player.connected = true; }
      for (const p of room.players) if (Date.now() - p.lastSeen > 60000) p.connected = false;
      advanceTime(room);
      if (!rooms.has(room.code)) return fail(res, 404, 'Room not found');
      return json(res, 200, { ...pub(room, pid), returnedFromAway });
    }
    const player = room.players.find(p => p.id === pid);
    if (!player) return fail(res, 403, 'Join the room first.');
    advanceTime(room);
    if (parts[2] === 'leave' && req.method === 'POST') {
      player.connected = false; player.lastSeen = 0;
      return json(res, 200, { ok: true });
    }
    if (parts[2] === 'settings' && req.method === 'POST' && pid === room.hostId && room.phase !== 'trade') {
      const allowed = ['mode', 'gamePlan', 'cycles', 'chat', 'customerSpeaksFirst', 'odd', 'lateJoin'];
      for (const key of allowed) { if (!(key in (data.settings || {}))) continue; if (room.started && (key === 'gamePlan' || key === 'cycles' || key === 'customerSpeaksFirst' || (key === 'mode' && room.settings.gamePlan !== 'manual'))) continue; room.settings[key] = data.settings[key]; }
      if (![2,4,6].includes(Number(room.settings.cycles))) room.settings.cycles = 4;
      if (!['rotate','menu-first','manual'].includes(room.settings.gamePlan)) room.settings.gamePlan = 'rotate';
    }
    if (parts[2] === 'start' && req.method === 'POST' && pid === room.hostId && room.phase === 'lobby') {
      const practice = !!data.practice;
      if (!practice) { room.realRound = 0; room.block = 0; room.blockRound = 0; room.seenModes = []; }
      if (startRound(room, practice) && practice) room.practiceDone = false;
    }
    if (parts[2] === 'talk' && req.method === 'POST' && room.phase === 'trade' && room.step === 'talk') {
      const pair = room.pairs.find(p => (p.a === pid || p.b === pid) && (p.roleA === 'Buyer' ? p.a === pid : p.b === pid));
      if (!pair) return fail(res, 403, 'Only the customer can send a signal.');
      const buyerId = pair.roleA === 'Buyer' ? pair.a : pair.b;
      if (pid !== buyerId) return fail(res, 403, 'Only the customer can send a signal.');
      const choice = customerSignals.find(x => x.text === data.signal);
      if (!choice) return fail(res, 400, 'Choose one of the customer signals.');
      if (!room.signals[pair.a]) room.signals[pair.a] = { buyer: buyerId, text: choice.text, kind: choice.kind, bluff: ['small','medium','large'].includes(choice.kind) && choice.kind !== ['small','medium','large'][pair.cardType] };
      const buyers = room.pairs.filter(p => (p.roleA === 'Buyer' ? p.a : p.b) !== 'bot');
      if (buyers.every(p => room.signals[p.a])) closeTalk(room);
    }
    if (parts[2] === 'offer' && req.method === 'POST' && room.phase === 'trade' && room.step === 'offer') {
      const pair = room.pairs.find(p => (p.a === pid || p.b === pid) && (p.roleA === 'Seller' ? p.a === pid : p.b === pid));
      if (!Number.isInteger(Number(data.quantity)) || Number(data.quantity) < 1 || Number(data.quantity) > 6) return fail(res, 400, 'Choose 1 to 6 servings.');
      if (pair && !pairDone(room, pair)) makeOffer(room, pair, pid, Number(data.quantity));
    }
    if (parts[2] === 'respond' && req.method === 'POST' && room.phase === 'trade' && room.step === 'respond') {
      const pair = room.pairs.find(p => (p.a === pid || p.b === pid) && (p.roleA === 'Buyer' ? p.a === pid : p.b === pid));
      const offer = pair && room.offers[pair.a];
      if (pair && offer && !pairDone(room, pair)) {
        const veto = !!data.veto;
        const requested = Number(data.quantity);
        if (!veto && (!Number.isInteger(requested) || requested < 1 || requested > 6)) return fail(res, 400, 'Choose 1 to 6 servings, or veto.');
        if (!veto && offer.mode === 'menu' && requested < offer.quantity) return fail(res, 400, `Choose at least ${offer.quantity} servings, or veto.`);
        const quantity = offer.mode === 'menu' ? (veto ? offer.quantity : requested) : offer.quantity;
        settle(room, pair, quantity, { veto });
      }
    }
    if (parts[2] === 'ready' && req.method === 'POST' && (room.phase === 'reveal' || room.phase === 'transition')) {
      room.ready[pid] = true;
      advanceIfReady(room);
    }
    if (parts[2] === 'next' && req.method === 'POST' && pid === room.hostId && room.phase === 'reveal') advanceFromReveal(room);
    if (parts[2] === 'continue' && req.method === 'POST' && pid === room.hostId && room.phase === 'transition') startRound(room, false);
    if ((parts[2] === 'play-again' || parts[2] === 'new-game') && req.method === 'POST' && pid === room.hostId && room.phase === 'ended') {
      for (const p of room.players) { p.score = 0; p.lastRole = null; p.rotation = { buyer: 0, seller: 0, sitOut: 0 }; }
      room.history = []; room.round = 0; room.realRound = 0; room.block = 0; room.blockRound = 0; room.seenModes = []; room.transitionMode = null; room.transitionFullRules = false; room.practiceDone = false; room.started = false; room.botLastRole = null; room.leaderboardScores = {}; room.rankChanges = {}; room.topEarners = []; room.roundFinalized = false; room.finalReveal = false;
      room.practice = false; room.ready = {}; room.phase = 'lobby'; room.roundSitter = null; room.step = null; room.pairs = []; room.offers = {}; room.messages = {}; room.signals = {};
    }
    if (parts[2] === 'close' && req.method === 'POST' && pid === room.hostId) rooms.delete(room.code);
    if (parts[2] === 'reset' && req.method === 'POST' && pid === room.hostId && room.phase !== 'trade') {
      for (const p of room.players) { p.score = 0; p.lastRole = null; p.rotation = { buyer: 0, seller: 0, sitOut: 0 }; }
      room.history = []; room.round = 0; room.realRound = 0; room.block = 0; room.blockRound = 0; room.seenModes = []; room.transitionMode = null; room.transitionFullRules = false; room.practiceDone = false; room.started = false; room.botLastRole = null; room.leaderboardScores = {}; room.rankChanges = {}; room.topEarners = []; room.roundFinalized = false; room.finalReveal = false;
      room.practice = false; room.ready = {}; room.phase = 'lobby'; room.roundSitter = null; room.step = null; room.pairs = []; room.offers = {}; room.messages = {}; room.signals = {}; room.finalReveal = false;
    }
    if (parts[2] === 'end' && req.method === 'POST' && pid === room.hostId) {
      if (room.phase === 'trade') for (const pair of room.pairs) if (!pairDone(room, pair)) settle(room, pair, 0, { veto: true, reason: 'game_ended' });
      room.ready = {}; room.phase = 'ended'; room.finalReveal = true;
    }
    return json(res, 200, pub(room, pid));
  });
});
setInterval(() => { const cutoff = Date.now() - ROOM_IDLE_MS; for (const [roomCode, room] of rooms) if (room.lastActivity < cutoff) rooms.delete(roomCode); }, 60000).unref?.();
server.listen(PORT, '0.0.0.0', () => console.log(`Hidden Appetite is running on http://localhost:${PORT}`));

