// Последние Врата — игровой сервер, этап 1: аккаунты, облачное сохранение, друзья, статусы.
// Без внешних зависимостей: node:http, node:crypto, node:sqlite (Node 22+).
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'lastgates.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, nick TEXT NOT NULL, nkey TEXT NOT NULL UNIQUE, tag TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid INTEGER NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chars(uid INTEGER PRIMARY KEY, data TEXT, saved INTEGER, race TEXT, lvl INTEGER, ms INTEGER);
CREATE TABLE IF NOT EXISTS friends(a INTEGER NOT NULL, b INTEGER NOT NULL, state TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY(a,b));
CREATE TABLE IF NOT EXISTS hall(id INTEGER PRIMARY KEY, uid INTEGER, data TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS chars2(uid INTEGER NOT NULL, slot INTEGER NOT NULL, data TEXT, saved INTEGER, race TEXT, lvl INTEGER, ms INTEGER, PRIMARY KEY(uid, slot));`);
try { db.exec('ALTER TABLE users ADD COLUMN cur INTEGER DEFAULT 0'); } catch (e) {}
if (!db.prepare('SELECT 1 FROM chars2 LIMIT 1').get()) db.exec('INSERT OR IGNORE INTO chars2(uid,slot,data,saved,race,lvl,ms) SELECT uid,0,data,saved,race,lvl,ms FROM chars');
// активный герой аккаунта: для друзей, группы и Арены
const CUR = 'chars2 c ON c.uid=u.id AND c.slot=u.cur';

const now = () => Date.now();
const DAY = 864e5;
const RACES = ['human', 'barb', 'elf', 'delf', 'dwarf', 'beast'];
const RANKS_T = [0, 1000, 5000, 10000, 20000];
const MAX_FRIENDS = 50;
const presence = new Map(); // uid -> {st, f, t}

function scryptHash(pass, salt) { return crypto.scryptSync(pass, salt, 64).toString('hex'); }
function rankOf(ms) { let r = 1; for (let i = 1; i < RANKS_T.length; i++) if ((ms || 0) >= RANKS_T[i]) r = i + 1; return r; }
function online(uid) { const p = presence.get(uid); return p && now() - p.t < 75e3 ? p : null; }

// ---- ограничение частоты запросов на вход/регистрацию
const hits = new Map();
function limited(ip, key, max, win) {
  const k = key + ip, t = now(), a = (hits.get(k) || []).filter(x => t - x < win);
  a.push(t); hits.set(k, a); return a.length > max;
}
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.some(x => t - x < 36e5)) hits.delete(k);
  db.prepare('DELETE FROM sessions WHERE exp<?').run(t); }, 6e5).unref();

// ---- проверка сохранения: сервер на этапе 1 ещё не считает бой, поэтому отсекаем явную подделку
function checkChar(c) {
  if (!c || typeof c !== 'object') return 'нет данных героя';
  if (RACES.indexOf(c.race) < 0) return 'неизвестная раса';
  if (!(c.lvl >= 1 && c.lvl <= 25)) return 'уровень вне пределов';
  if (!(c.gold >= 0 && c.gold <= 1e8)) return 'золото вне пределов';
  if (!Array.isArray(c.st) || c.st.length !== 6 || c.st.some(v => !(v >= 0 && v <= 400))) return 'характеристики вне пределов';
  if ((c.bag || []).length > 20 || (c.stash || []).length > 40) return 'слишком много вещей';
  return null;
}

function friendRows(uid) {
  return db.prepare(`SELECT f.b AS id, f.state, u.nick, u.tag, c.race, c.lvl, c.ms FROM friends f JOIN users u ON u.id=f.b LEFT JOIN ${CUR} WHERE f.a=?`).all(uid);
}
function pubUser(r) {
  const p = online(r.id);
  return { id: r.id, nick: r.nick, tag: r.tag, race: r.race || null, lvl: r.lvl || 0, rank: rankOf(r.ms), online: !!p, st: p ? p.st : 'off', f: p ? p.f : 0 };
}

// ---- маршруты
const R = {};
R['GET /api/health'] = () => ({ ok: true, t: now() });

R['POST /api/register'] = (q, b) => {
  if (limited(q.ip, 'reg', 10, 36e5)) return [429, 'Слишком много попыток, подождите час'];
  const nick = String(b.nick || '').trim(), pass = String(b.pass || '');
  if (!/^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/.test(nick)) return [400, 'Ник: 3–16 букв, цифр или _'];
  if (pass.length < 6 || pass.length > 64) return [400, 'Пароль: от 6 до 64 символов'];
  if (db.prepare('SELECT 1 FROM users WHERE nkey=?').get(nick.toLowerCase())) {
    let alt = null;
    for (let i = 1; i < 1000 && !alt; i++) { const v = (nick.slice(0, 16 - String(i).length) + i); if (!db.prepare('SELECT 1 FROM users WHERE nkey=?').get(v.toLowerCase())) alt = v; }
    return [409, 'Ник «' + nick + '» уже занят', { suggest: alt }];
  }
  const salt = crypto.randomBytes(16).toString('hex'), tag = String(1000 + crypto.randomInt(9000));
  const r = db.prepare('INSERT INTO users(nick,nkey,tag,salt,hash,created) VALUES(?,?,?,?,?,?)').run(nick, nick.toLowerCase(), tag, salt, scryptHash(pass, salt), now());
  return session(Number(r.lastInsertRowid), nick, tag);
};
R['POST /api/login'] = (q, b) => {
  if (limited(q.ip, 'login', 20, 6e5)) return [429, 'Слишком много попыток, подождите 10 минут'];
  const u = db.prepare('SELECT * FROM users WHERE nkey=?').get(String(b.nick || '').trim().toLowerCase());
  if (!u) return [401, 'Неверный ник или пароль'];
  const h = scryptHash(String(b.pass || ''), u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'))) return [401, 'Неверный ник или пароль'];
  return session(u.id, u.nick, u.tag);
};
function session(uid, nick, tag) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,uid,exp) VALUES(?,?,?)').run(token, uid, now() + 30 * DAY);
  return { token, nick, tag };
}
R['POST /api/logout'] = (q) => { db.prepare('DELETE FROM sessions WHERE token=?').run(q.token); return { ok: true }; };

const slotOf = v => Math.max(0, Math.min(2, v | 0));
R['GET /api/me'] = (q) => {
  const c = db.prepare('SELECT COUNT(*) AS n FROM chars2 WHERE uid=? AND data IS NOT NULL').get(q.uid);
  return { nick: q.user.nick, tag: q.user.tag, heroes: c.n };
};
R['GET /api/chars'] = (q) => {
  const rows = db.prepare('SELECT slot, data, saved FROM chars2 WHERE uid=? AND data IS NOT NULL').all(q.uid), out = [null, null, null];
  rows.forEach(r => { try { const c = JSON.parse(r.data); out[r.slot] = { race: c.race, lvl: c.lvl, gold: c.gold, ms: c.ms || 0, ar: c.ar ? c.ar.r : 1000, saved: r.saved }; } catch (e) {} });
  return { slots: out };
};
R['GET /api/save'] = (q) => {
  const c = db.prepare('SELECT data, saved FROM chars2 WHERE uid=? AND slot=?').get(q.uid, slotOf(q.query.slot));
  return { char: c && c.data ? JSON.parse(c.data) : null, saved: c ? c.saved : 0 };
};
R['PUT /api/save'] = (q, b) => {
  const sl = slotOf(b.slot);
  if (b.died) {
    const old = db.prepare('SELECT data FROM chars2 WHERE uid=? AND slot=?').get(q.uid, sl);
    if (old && old.data && !b.del) db.prepare('INSERT INTO hall(uid,data,at) VALUES(?,?,?)').run(q.uid, old.data, now());
    db.prepare('INSERT INTO chars2(uid,slot,data,saved,race,lvl,ms) VALUES(?,?,NULL,?,NULL,0,0) ON CONFLICT(uid,slot) DO UPDATE SET data=NULL,saved=excluded.saved,race=NULL,lvl=0,ms=0').run(q.uid, sl, now());
    return { ok: true, saved: now() };
  }
  const err = checkChar(b.char); if (err) return [400, 'Сохранение отклонено: ' + err];
  const t = now(), c = b.char;
  db.prepare('INSERT INTO chars2(uid,slot,data,saved,race,lvl,ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(uid,slot) DO UPDATE SET data=excluded.data,saved=excluded.saved,race=excluded.race,lvl=excluded.lvl,ms=excluded.ms')
    .run(q.uid, sl, JSON.stringify(c), t, c.race, c.lvl | 0, c.ms | 0);
  db.prepare('UPDATE users SET cur=? WHERE id=?').run(sl, q.uid);
  return { ok: true, saved: t };
};
R['POST /api/status'] = (q, b) => {
  presence.set(q.uid, { st: b.st === 'run' ? 'run' : b.st === 'arena' ? 'arena' : 'city', f: Math.max(0, Math.min(10, b.f | 0)), t: now() });
  return { ok: true };
};

R['GET /api/friends'] = (q) => {
  const rows = friendRows(q.uid);
  const inc = db.prepare('SELECT u.id, u.nick, u.tag FROM friends f JOIN users u ON u.id=f.a WHERE f.b=? AND f.state=\'pending\'').all(q.uid);
  return {
    code: q.user.nick,
    friends: rows.filter(r => r.state === 'ok').map(pubUser).sort((x, y) => (y.online - x.online) || x.nick.localeCompare(y.nick)),
    outgoing: rows.filter(r => r.state === 'pending').map(r => ({ id: r.id, nick: r.nick, tag: r.tag })),
    incoming: inc
  };
};
R['POST /api/friends/add'] = (q, b) => {
  const nk = String(b.code || b.nick || '').trim().replace(/#\d*$/, '').toLowerCase();
  if (nk.length < 3) return [400, 'Введите ник друга'];
  const u = db.prepare('SELECT id,nick,tag FROM users WHERE nkey=?').get(nk);
  if (!u) return [404, 'Игрок с таким ником не найден'];
  if (u.id === q.uid) return [400, 'Это ваш собственный ник'];
  if (db.prepare('SELECT COUNT(*) AS n FROM friends WHERE a=? AND state=\'ok\'').get(q.uid).n >= MAX_FRIENDS) return [400, 'В списке уже ' + MAX_FRIENDS + ' друзей'];
  const back = db.prepare('SELECT state FROM friends WHERE a=? AND b=?').get(u.id, q.uid);
  if (back && back.state === 'pending') { addFriendship(q.uid, u.id); return { ok: true, msg: u.nick + ' теперь в друзьях' }; }
  if (back && back.state === 'ok') return { ok: true, msg: u.nick + ' уже в друзьях' };
  if (back && back.state === 'block') return [404, 'Игрок с таким ником не найден'];
  db.prepare('INSERT OR IGNORE INTO friends(a,b,state,since) VALUES(?,?,\'pending\',?)').run(q.uid, u.id, now());
  return { ok: true, msg: 'Заявка отправлена: ' + u.nick };
};
function addFriendship(a, b) {
  const t = now();
  db.prepare('INSERT INTO friends(a,b,state,since) VALUES(?,?,\'ok\',?) ON CONFLICT(a,b) DO UPDATE SET state=\'ok\'').run(a, b, t);
  db.prepare('INSERT INTO friends(a,b,state,since) VALUES(?,?,\'ok\',?) ON CONFLICT(a,b) DO UPDATE SET state=\'ok\'').run(b, a, t);
}
R['POST /api/friends/accept'] = (q, b) => {
  const r = db.prepare('SELECT 1 FROM friends WHERE a=? AND b=? AND state=\'pending\'').get(b.id | 0, q.uid);
  if (!r) return [404, 'Заявка не найдена'];
  addFriendship(q.uid, b.id | 0); return { ok: true };
};
R['POST /api/friends/decline'] = (q, b) => { db.prepare('DELETE FROM friends WHERE a=? AND b=? AND state=\'pending\'').run(b.id | 0, q.uid); return { ok: true }; };
R['POST /api/friends/remove'] = (q, b) => {
  db.prepare('DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').run(q.uid, b.id | 0, b.id | 0, q.uid); return { ok: true };
};
R['POST /api/friends/block'] = (q, b) => {
  db.prepare('DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').run(q.uid, b.id | 0, b.id | 0, q.uid);
  db.prepare('INSERT INTO friends(a,b,state,since) VALUES(?,?,\'block\',?)').run(q.uid, b.id | 0, now()); return { ok: true };
};
const OPEN = new Set(['GET /api/health', 'POST /api/register', 'POST /api/login']);

// ---- HTTP
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Cache-Control': 'no-store' });
  res.end(body);
}
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = req.url.split('?')[0], key = req.method + ' ' + url, fn = R[key], query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  if (!fn) return send(res, 404, { error: 'Нет такого адреса' });
  let size = 0; const chunks = [];
  req.on('data', d => { size += d.length; if (size > 400e3) { send(res, 413, { error: 'Слишком большой запрос' }); req.destroy(); } else chunks.push(d); });
  req.on('end', () => {
    if (res.writableEnded) return;
    let b = {};
    try { if (chunks.length) b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, 400, { error: 'Неверный JSON' }); }
    const q = { ip: req.headers['x-real-ip'] || req.socket.remoteAddress, query };
    if (!OPEN.has(key)) {
      const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const s = tok && db.prepare('SELECT s.uid, s.exp, u.nick, u.tag FROM sessions s JOIN users u ON u.id=s.uid WHERE s.token=?').get(tok);
      if (!s || s.exp < now()) return send(res, 401, { error: 'Нужно войти в аккаунт заново' });
      q.uid = s.uid; q.token = tok; q.user = { nick: s.nick, tag: s.tag };
    }
    try {
      const r = fn(q, b);
      if (Array.isArray(r)) send(res, r[0], Object.assign({ error: r[1] }, r[2] || {})); else send(res, 200, r);
    } catch (e) { console.error(key, e); send(res, 500, { error: 'Ошибка сервера' }); }
  });
});

// ================= WebSocket (RFC 6455, без зависимостей) + группы
const conns = new Map();   // uid -> conn
const parties = new Map(); // pid -> {id, leader, members:[uid], ready:{}, state, host}
const userParty = new Map();
const invites = new Map(); // uid -> Map(pid -> t)
const looks = new Map();   // uid -> внешний вид героя для портретов
const aq = [];             // очередь Арены: {uid, r, t}
const duels = new Map();   // id -> {id, a, b, host}
const userDuel = new Map();
let duelSeq = 1;
const graces = new Map(); // uid -> таймер: держим место в группе/дуэли при кратком обрыве
let pidSeq = 1;

function wsSend(c, obj) {
  if (!c || c.dead) return;
  const data = Buffer.from(JSON.stringify(obj));
  let head;
  if (data.length < 126) head = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  try { c.sock.write(Buffer.concat([head, data])); } catch (e) {}
}
function toUid(uid, obj) { wsSend(conns.get(uid), obj); }
function nickOf(uid) { const u = db.prepare('SELECT nick FROM users WHERE id=?').get(uid); return u ? u.nick : '?'; }
function partyView(p) {
  return { id: p.id, leader: p.leader, state: p.state, host: p.host || 0, members: p.members.map(uid => {
    const c = db.prepare('SELECT c.race,c.lvl FROM users u JOIN ' + CUR + ' WHERE u.id=?').get(uid) || {};
    const pr = online(uid);
    return { uid, nick: nickOf(uid), race: c.race || null, lvl: c.lvl || 0, ready: !!p.ready[uid], online: conns.has(uid), look: looks.get(uid) || null, st: pr ? pr.st : 'off', f: pr ? pr.f : 0 };
  }) };
}
function partyPush(p) { const v = partyView(p); p.members.forEach(uid => toUid(uid, { t: 'party', p: v })); }
function leaveParty(uid, why) {
  const pid = userParty.get(uid); if (!pid) return; const p = parties.get(pid); userParty.delete(uid); if (!p) return;
  p.members = p.members.filter(x => x !== uid); delete p.ready[uid];
  toUid(uid, { t: 'party', p: null });
  if (p.state === 'run') { if (p.host === uid) p.members.forEach(m => toUid(m, { t: 'hostgone' })); else toUid(p.host, { t: 'left', uid }); }
  if (p.members.length < 2 && p.state !== 'run') { p.members.forEach(m => { userParty.delete(m); toUid(m, { t: 'party', p: null }); }); parties.delete(pid); return; }
  if (!p.members.length) { parties.delete(pid); return; }
  if (p.leader === uid) p.leader = p.members[0];
  partyPush(p);
}
function areFriends(a, b) { return !!db.prepare("SELECT 1 FROM friends WHERE a=? AND b=? AND state='ok'").get(a, b); }

function onMsg(c, m) {
  const uid = c.uid, pid = userParty.get(uid), p = pid && parties.get(pid);
  presence.set(uid, Object.assign(presence.get(uid) || { st: 'city', f: 0 }, { t: now() }));
  switch (m.t) {
    case 'ping': return wsSend(c, { t: 'pong' });
    case 'st': { const o = presence.get(uid) || {}, ns = m.st === 'run' ? 'run' : m.st === 'arena' ? 'arena' : 'city', nf = Math.max(0, Math.min(10, m.f | 0));
      presence.set(uid, { st: ns, f: nf, t: now() }); if (p && (o.st !== ns || o.f !== nf)) partyPush(p); return; }
    case 'look': { const j = JSON.stringify(m.o || null); if (j.length < 3000) { looks.set(uid, m.o); if (p) partyPush(p); } return; }
    case 'aq': {
      if (userDuel.get(uid)) return;
      const i0 = aq.findIndex(x => x.uid === uid); if (i0 >= 0) aq.splice(i0, 1);
      const r = Math.max(0, Math.min(5000, m.r | 0));
      let best = -1, bd = 1e9; aq.forEach((x, i) => { if (!conns.has(x.uid)) return; const d = Math.abs(x.r - r); if (d < bd) { bd = d; best = i; } });
      if (best < 0) { aq.push({ uid, r, t: now() }); return wsSend(c, { t: 'aqw' }); }
      const o = aq.splice(best, 1)[0], d = { id: duelSeq++, a: o.uid, b: uid, host: o.uid };
      duels.set(d.id, d); userDuel.set(d.a, d.id); userDuel.set(d.b, d.id);
      const mem = [{ uid: d.a, nick: nickOf(d.a), r: o.r }, { uid: d.b, nick: nickOf(d.b), r }];
      [d.a, d.b].forEach(x => { toUid(x, { t: 'duel', id: d.id, host: d.host, members: mem }); presence.set(x, { st: 'arena', f: 0, t: now() }); });
      return;
    }
    case 'aleave': { const i1 = aq.findIndex(x => x.uid === uid); if (i1 >= 0) aq.splice(i1, 1); return; }
    case 'dend': { const did = userDuel.get(uid), d = did && duels.get(did); if (d) { duels.delete(did); userDuel.delete(d.a); userDuel.delete(d.b); } return; }
    case 'inv': {
      const u = db.prepare('SELECT id,nick FROM users WHERE nkey=?').get(String(m.nick || '').toLowerCase());
      if (!u || !areFriends(uid, u.id)) return wsSend(c, { t: 'err', msg: 'Пригласить можно только друга' });
      if (!conns.has(u.id)) return wsSend(c, { t: 'err', msg: u.nick + ' не в сети' });
      if (userParty.get(u.id) && userParty.get(u.id) === pid) return wsSend(c, { t: 'err', msg: u.nick + ' уже в группе' });
      if (userParty.get(u.id)) return wsSend(c, { t: 'err', msg: u.nick + ' уже в другой группе' });
      let q = p;
      if (!q) { q = { id: pidSeq++, leader: uid, members: [uid], ready: {}, state: 'lobby', host: 0 }; parties.set(q.id, q); userParty.set(uid, q.id); }
      if (q.leader !== uid) return wsSend(c, { t: 'err', msg: 'Приглашать может только ведущий' });
      if (q.state !== 'lobby') return wsSend(c, { t: 'err', msg: 'Группа уже в Лабиринте' });
      if (q.members.length >= 3) return wsSend(c, { t: 'err', msg: 'В группе уже 3 героя' });
      if (!invites.has(u.id)) invites.set(u.id, new Map()); invites.get(u.id).set(q.id, now());
      toUid(u.id, { t: 'invite', pid: q.id, from: c.nick });
      partyPush(q); return wsSend(c, { t: 'msg', msg: 'Приглашение отправлено: ' + u.nick });
    }
    case 'acc': {
      const iv = invites.get(uid), q = parties.get(m.pid | 0);
      if (!iv || !iv.has(m.pid | 0) || !q || now() - iv.get(m.pid | 0) > 120e3) return wsSend(c, { t: 'err', msg: 'Приглашение устарело' });
      iv.delete(m.pid | 0);
      if (q.state !== 'lobby' || q.members.length >= 3) return wsSend(c, { t: 'err', msg: 'В группу уже не войти' });
      if (pid) leaveParty(uid);
      q.members.push(uid); userParty.set(uid, q.id); partyPush(q); return;
    }
    case 'dec': { const iv = invites.get(uid); if (iv) iv.delete(m.pid | 0); const q = parties.get(m.pid | 0); if (q) toUid(q.leader, { t: 'msg', msg: c.nick + ' отклонил приглашение' }); return; }
    case 'leave': return leaveParty(uid);
    case 'kick': if (p && p.leader === uid && m.uid !== uid && p.members.includes(m.uid | 0) && p.state === 'lobby') { toUid(m.uid | 0, { t: 'msg', msg: 'Ведущий исключил вас из группы' }); leaveParty(m.uid | 0); } return;
    case 'ready': if (p && p.state === 'lobby') { p.ready[uid] = !!m.v; partyPush(p); } return;
    case 'start': {
      if (!p || p.leader !== uid || p.state !== 'lobby') return;
      const notReady = p.members.filter(x => x !== uid && (!p.ready[x] || !conns.has(x)));
      if (notReady.length) return wsSend(c, { t: 'err', msg: 'Не все готовы: ' + notReady.map(nickOf).join(', ') });
      p.state = 'run'; p.host = uid;
      const mem = p.members.map(x => ({ uid: x, nick: nickOf(x) }));
      p.members.forEach(x => toUid(x, { t: 'start', host: uid, members: mem }));
      partyPush(p); return;
    }
    case 'rel': {
      const did = userDuel.get(uid), dd = did && duels.get(did);
      if (dd) { const other = dd.a === uid ? dd.b : dd.a; toUid(other, { t: 'rel', from: uid, d: m.d }); return; }
      if (!p || p.state !== 'run') return;
      if (uid === p.host) { if (m.to) { if (p.members.includes(m.to | 0)) toUid(m.to | 0, { t: 'rel', from: uid, d: m.d }); } else p.members.forEach(x => { if (x !== uid) toUid(x, { t: 'rel', from: uid, d: m.d }); }); }
      else toUid(p.host, { t: 'rel', from: uid, d: m.d });
      return;
    }
    case 'end': if (p && p.host === uid && p.state === 'run') { p.state = 'lobby'; p.host = 0; p.ready = {}; p.members.forEach(x => { if (x !== uid) toUid(x, { t: 'rel', from: uid, d: m.d || { t: 'end' } }); }); partyPush(p); } return;
  }
}

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  const fail = () => { try { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch (e) {} };
  if (u.pathname !== '/ws') return fail();
  const tok = u.searchParams.get('token') || '';
  const s = tok && db.prepare('SELECT s.uid, s.exp, u.nick FROM sessions s JOIN users u ON u.id=s.uid WHERE s.token=?').get(tok);
  if (!s || s.exp < now()) return fail();
  const key = req.headers['sec-websocket-key']; if (!key) return fail();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { uid: s.uid, nick: s.nick, sock, buf: Buffer.alloc(0), dead: false, seen: now() };
  const old = conns.get(c.uid); if (old) { old.dead = true; try { old.sock.destroy(); } catch (e) {} }
  if (graces.has(c.uid)) { clearTimeout(graces.get(c.uid)); graces.delete(c.uid); }
  conns.set(c.uid, c);
  presence.set(c.uid, Object.assign(presence.get(c.uid) || { st: 'city', f: 0 }, { t: now() }));
  wsSend(c, { t: 'hello', uid: c.uid, nick: c.nick });
  const pid = userParty.get(c.uid); if (pid && parties.get(pid)) partyPush(parties.get(pid)); else wsSend(c, { t: 'party', p: null });
  const iv = invites.get(c.uid); if (iv) for (const [ip, t] of iv) if (now() - t < 120e3 && parties.get(ip)) wsSend(c, { t: 'invite', pid: ip, from: nickOf(parties.get(ip).leader) });
  sock.on('data', d => {
    c.seen = now(); c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > 600e3) return sock.destroy();
    for (;;) {
      const b = c.buf; if (b.length < 2) break;
      const op = b[0] & 15, masked = b[1] & 128; let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 512e3) return sock.destroy();
      const need = off + (masked ? 4 : 0) + len; if (b.length < need) break;
      let pl = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mk = b.subarray(off, off + 4); pl = Buffer.from(pl); for (let i = 0; i < pl.length; i++) pl[i] ^= mk[i & 3]; }
      c.buf = b.subarray(need);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, pl.length]), pl])); } catch (e) {} continue; }
      if (op === 1) { let m; try { m = JSON.parse(pl.toString('utf8')); } catch (e) { continue; } try { onMsg(c, m); } catch (e) { console.error('ws', e); } }
    }
  });
  const bye = () => {
    if (c.dead) return; c.dead = true; if (conns.get(c.uid) === c) conns.delete(c.uid);
    const uid = c.uid;
    const qi = aq.findIndex(x => x.uid === uid); if (qi >= 0) aq.splice(qi, 1);
    const pid2 = userParty.get(uid), p = pid2 && parties.get(pid2);
    if (p && p.state !== 'run') partyPush(p);
    if (userDuel.get(uid) || (p && p.state === 'run')) {
      if (graces.has(uid)) clearTimeout(graces.get(uid));
      graces.set(uid, setTimeout(() => {
        graces.delete(uid); if (conns.has(uid)) return;
        const did = userDuel.get(uid), dd = did && duels.get(did);
        if (dd) { const other = dd.a === uid ? dd.b : dd.a; toUid(other, { t: 'dgone' }); duels.delete(did); userDuel.delete(dd.a); userDuel.delete(dd.b); }
        const pid3 = userParty.get(uid), p3 = pid3 && parties.get(pid3);
        if (p3) { if (p3.state === 'run') leaveParty(uid); else partyPush(p3); }
      }, 20000));
    }
  };
  sock.on('close', bye); sock.on('error', bye);
});
setInterval(() => { const t = now(); for (const c of conns.values()) { if (t - c.seen > 70e3) { try { c.sock.destroy(); } catch (e) {} } else wsSend(c, { t: 'ka' }); } }, 25e3).unref();

server.listen(PORT, HOST, () => console.log('Последние Врата: сервер на ' + HOST + ':' + PORT + ', данные в ' + DATA));
