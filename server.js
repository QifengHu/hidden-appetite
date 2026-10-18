const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const cards = [
  { name: 'Nibble', values: [0, 6, 8, 6, 2, -4, -12], color: 'mint' },
  { name: 'Balanced', values: [0, 3, 7, 10, 10, 6, 0], color: 'blue' },
  { name: 'Feast', values: [0, 1, 3, 6, 10, 15, 18], color: 'coral' }
];
const id = () => crypto.randomBytes(8).toString('hex');
const code = () => crypto.randomBytes(3).toString('hex').toUpperCase();
function freshRoom(hostId, hostName, settings) {
  return { code: code(), hostId, players: [{ id: hostId, name: hostName, score: 0, connected: true, joined: Date.now() }], settings: { mode: 'single', chat: true, odd: 'sit', ...settings }, round: 0, phase: 'lobby', deadline: 0, pairs: [], history: [], ready: [], offers: {}, messages: [], updated: Date.now() };
}
function pub(room, pid) {
  const mine = room.pairs.find(x => x.a === pid || x.b === pid);
  return { code: room.code, hostId: room.hostId, players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, role: room.pairs.find(x => x.a === p.id || x.b === p.id)?.[room.pairs.find(x => x.a === p.id || x.b === p.id).a === p.id ? 'roleA' : 'roleB'] || null })), settings: room.settings, round: room.round, phase: room.phase, deadline: room.deadline, pairs: room.pairs.map(x => ({ a: x.a, b: x.b, roleA: x.roleA, roleB: x.roleB })), yourCard: mine && ((mine.a === pid && mine.roleA === 'Buyer') || (mine.b === pid && mine.roleB === 'Buyer')) ? { name: mine.card.name, values: mine.card.values, color: mine.card.color } : null, yourPair: mine ? mine.a : null, history: room.history, offer: mine ? room.offers?.[mine.a] || null : null, messages: room.messages.slice(-30), yourId: pid };
}
function startRound(room) {
  const active = room.players.filter(p => p.connected);
  if (active.length < 2) { room.phase = 'lobby'; return; }
  const shuffled = [...active].sort(() => Math.random() - .5);
  if (shuffled.length % 2) {
    if (room.settings.odd === 'bot') shuffled.push({ id: 'bot', name: 'Miso 🤖', score: 0, connected: true });
    else shuffled.pop();
  }
  room.round++;
  const previous = new Map(room.pairs.flatMap(x => [[x.a, x.roleA], [x.b, x.roleB]]));
  room.pairs = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    let a = shuffled[i], b = shuffled[i + 1];
    let roleA = room.round === 1 ? (Math.random() < .5 ? 'Seller' : 'Buyer') : (previous.get(a.id) === 'Seller' ? 'Buyer' : 'Seller');
    const p = { a: a.id, b: b.id, roleA, roleB: roleA === 'Seller' ? 'Buyer' : 'Seller', cardType: Math.floor(Math.random() * cards.length), card: null };
    p.card = cards[p.cardType]; room.pairs.push(p);
  }
  room.phase = 'trade'; room.offers = {}; room.messages = []; room.ready = []; room.deadline = Date.now() + 60000;
}
function settle(room, pair, quantity, veto = false) {
  if (room.history.some(h => h.round === room.round && h.a === pair.a)) return;
  const q = veto ? 0 : quantity;
  const buyerId = pair.roleA === 'Buyer' ? pair.a : pair.b, sellerId = buyerId === pair.a ? pair.b : pair.a;
  const b = room.players.find(p => p.id === buyerId), s = room.players.find(p => p.id === sellerId);
  const buyerPoints = pair.card.values[q], sellerPoints = q * 5;
  if (b) b.score += buyerPoints; if (s) s.score += sellerPoints;
  room.history.push({ round: room.round, a: pair.a, b: pair.b, buyer: buyerId, seller: sellerId, cardType: pair.cardType, cardName: pair.card.name, values: pair.card.values, quantity: q, veto, buyerPoints, sellerPoints, table: pair.card.values.slice(0, 7).reduce((sum, v, i) => sum + Math.max(0, v - i * 5), 0), mode: room.settings.mode });
  if (room.pairs.every(p => room.history.some(h => h.round === room.round && h.a === p.a))) room.phase = 'reveal';
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.url === '/' || req.url.startsWith('/?')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res); }
  const parts = req.url.split('/').filter(Boolean);
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    let data = {}; try { data = body ? JSON.parse(body) : {}; } catch {}
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'create') {
      const hostId = id(), room = freshRoom(hostId, String(data.name || 'Host').slice(0, 18), data.settings || {}); rooms.set(room.code, room); return json(res, 200, { code: room.code, id: hostId });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'join') {
      const room = rooms.get(String(data.code || '').toUpperCase()); if (!room) return json(res, 404, { error: 'Room not found. Check the code and try again.' });
      let player = room.players.find(p => p.id === data.id); if (!player) { player = { id: id(), name: String(data.name || 'Player').slice(0, 18), score: 0, connected: true, joined: Date.now() }; room.players.push(player); } else player.connected = true;
      return json(res, 200, { code: room.code, id: player.id });
    }
    if (parts[0] !== 'api' || !parts[1]) return json(res, 404, { error: 'Not found' });
    const room = rooms.get(parts[1].toUpperCase()); if (!room) return json(res, 404, { error: 'Room not found' });
    const pid = data.id || new URL(req.url, 'http://localhost').searchParams.get('id');
    if (req.method === 'GET' && parts[2] === 'state') { if (room.phase === 'trade' && Date.now() > room.deadline) { room.pairs.forEach(p => settle(room, p, 0, true)); room.phase = 'reveal'; } return json(res, 200, pub(room, pid)); }
    const player = room.players.find(p => p.id === pid); if (!player) return json(res, 403, { error: 'Join the room first.' });
    if (req.method === 'POST' && parts[2] === 'settings' && pid === room.hostId && room.phase !== 'trade') room.settings = { ...room.settings, ...data.settings };
    if (req.method === 'POST' && parts[2] === 'start' && pid === room.hostId) startRound(room);
    if (req.method === 'POST' && parts[2] === 'start' && pid === room.hostId && room.phase === 'trade') {
      for (const pair of room.pairs) {
        if (pair.a === 'bot' || pair.b === 'bot') {
          if (pair.roleA === 'Seller' ? pair.a === 'bot' : pair.b === 'bot') room.offers[pair.a] = { pair: pair.a, quantity: room.settings.mode === 'menu' ? 1 : 2, mode: room.settings.mode, by: 'bot' };
        }
      }
    }
    if (req.method === 'POST' && parts[2] === 'message' && room.settings.chat && room.phase === 'trade') { const allowed = ['Sounds good 👍', 'Hmm… tempting 🤔', 'That’s too much 😅', 'Let’s make a deal 🤝', 'I’m hungry! 😋', 'No deal 🙅']; if (allowed.includes(data.text)) room.messages.push({ id: pid, name: player.name, text: data.text }); }
    if (req.method === 'POST' && parts[2] === 'offer' && room.phase === 'trade') { const pair = room.pairs.find(p => (p.a === pid || p.b === pid) && (p.roleA === 'Seller' ? p.a === pid : p.b === pid)); if (pair) { room.offers[pair.a] = { pair: pair.a, quantity: Math.max(0, Math.min(6, Number(data.quantity) || 0)), mode: room.settings.mode, by: pid }; if (pair.a === 'bot' || pair.b === 'bot') { const min=room.offers[pair.a].quantity, choice=pair.card.values.slice(min).reduce((best,v,i)=>v>best.v?{q:min+i,v}:best,{q:min,v:pair.card.values[min]}); if (room.settings.mode==='menu') settle(room,pair,choice.v>=0?choice.q:0,choice.v<0); else settle(room,pair,pair.card.values[min]>=0?min:0,pair.card.values[min]<0); } } }
    if (req.method === 'POST' && parts[2] === 'respond' && room.phase === 'trade') { const pair = room.pairs.find(p => p.a === pid || p.b === pid), offer=pair && room.offers[pair.a]; if (pair && offer) settle(room, pair, data.veto ? 0 : Math.max(0, Math.min(6, Number(data.quantity ?? offer.quantity) || 0)), !!data.veto); }
    if (req.method === 'POST' && parts[2] === 'next' && pid === room.hostId && room.phase === 'reveal') startRound(room);
    room.updated = Date.now(); return json(res, 200, pub(room, pid));
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Hidden Appetite is running on http://localhost:${PORT}`));
