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
CREATE TABLE IF NOT EXISTS hall(id INTEGER PRIMARY KEY, uid INTEGER, data TEXT, at INTEGER);`);

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
  return db.prepare(`SELECT f.b AS id, f.state, u.nick, u.tag, c.race, c.lvl, c.ms FROM friends f JOIN users u ON u.id=f.b LEFT JOIN chars c ON c.uid=f.b WHERE f.a=?`).all(uid);
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
  if (db.prepare('SELECT 1 FROM users WHERE nkey=?').get(nick.toLowerCase())) return [409, 'Такой ник уже занят'];
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

R['GET /api/me'] = (q) => {
  const c = db.prepare('SELECT saved, data IS NOT NULL AS has FROM chars WHERE uid=?').get(q.uid);
  return { nick: q.user.nick, tag: q.user.tag, hasChar: !!(c && c.has), saved: c ? c.saved : 0 };
};
R['GET /api/save'] = (q) => {
  const c = db.prepare('SELECT data, saved FROM chars WHERE uid=?').get(q.uid);
  return { char: c && c.data ? JSON.parse(c.data) : null, saved: c ? c.saved : 0 };
};
R['PUT /api/save'] = (q, b) => {
  if (b.died) {
    const old = db.prepare('SELECT data FROM chars WHERE uid=?').get(q.uid);
    if (old && old.data) db.prepare('INSERT INTO hall(uid,data,at) VALUES(?,?,?)').run(q.uid, old.data, now());
    db.prepare('INSERT INTO chars(uid,data,saved,race,lvl,ms) VALUES(?,NULL,?,NULL,0,0) ON CONFLICT(uid) DO UPDATE SET data=NULL,saved=excluded.saved,race=NULL,lvl=0,ms=0').run(q.uid, now());
    return { ok: true, saved: now() };
  }
  const err = checkChar(b.char); if (err) return [400, 'Сохранение отклонено: ' + err];
  const t = now(), c = b.char;
  db.prepare('INSERT INTO chars(uid,data,saved,race,lvl,ms) VALUES(?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET data=excluded.data,saved=excluded.saved,race=excluded.race,lvl=excluded.lvl,ms=excluded.ms')
    .run(q.uid, JSON.stringify(c), t, c.race, c.lvl | 0, c.ms | 0);
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
    code: q.user.nick + '#' + q.user.tag,
    friends: rows.filter(r => r.state === 'ok').map(pubUser).sort((x, y) => (y.online - x.online) || x.nick.localeCompare(y.nick)),
    outgoing: rows.filter(r => r.state === 'pending').map(r => ({ id: r.id, nick: r.nick, tag: r.tag })),
    incoming: inc
  };
};
R['POST /api/friends/add'] = (q, b) => {
  const m = /^(.{3,16})#(\d{4})$/.exec(String(b.code || '').trim());
  if (!m) return [400, 'Код друга выглядит так: Ник#1234'];
  const u = db.prepare('SELECT id,nick,tag FROM users WHERE nkey=? AND tag=?').get(m[1].toLowerCase(), m[2]);
  if (!u) return [404, 'Игрок с таким кодом не найден'];
  if (u.id === q.uid) return [400, 'Это ваш собственный код'];
  if (db.prepare('SELECT COUNT(*) AS n FROM friends WHERE a=? AND state=\'ok\'').get(q.uid).n >= MAX_FRIENDS) return [400, 'В списке уже ' + MAX_FRIENDS + ' друзей'];
  const back = db.prepare('SELECT state FROM friends WHERE a=? AND b=?').get(u.id, q.uid);
  if (back && back.state === 'pending') { addFriendship(q.uid, u.id); return { ok: true, msg: u.nick + ' теперь в друзьях' }; }
  if (back && back.state === 'ok') return { ok: true, msg: u.nick + ' уже в друзьях' };
  if (back && back.state === 'block') return [404, 'Игрок с таким кодом не найден'];
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
  const url = req.url.split('?')[0], key = req.method + ' ' + url, fn = R[key];
  if (!fn) return send(res, 404, { error: 'Нет такого адреса' });
  let size = 0; const chunks = [];
  req.on('data', d => { size += d.length; if (size > 400e3) { send(res, 413, { error: 'Слишком большой запрос' }); req.destroy(); } else chunks.push(d); });
  req.on('end', () => {
    if (res.writableEnded) return;
    let b = {};
    try { if (chunks.length) b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, 400, { error: 'Неверный JSON' }); }
    const q = { ip: req.headers['x-real-ip'] || req.socket.remoteAddress };
    if (!OPEN.has(key)) {
      const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const s = tok && db.prepare('SELECT s.uid, s.exp, u.nick, u.tag FROM sessions s JOIN users u ON u.id=s.uid WHERE s.token=?').get(tok);
      if (!s || s.exp < now()) return send(res, 401, { error: 'Нужно войти в аккаунт заново' });
      q.uid = s.uid; q.token = tok; q.user = { nick: s.nick, tag: s.tag };
    }
    try {
      const r = fn(q, b);
      if (Array.isArray(r)) send(res, r[0], { error: r[1] }); else send(res, 200, r);
    } catch (e) { console.error(key, e); send(res, 500, { error: 'Ошибка сервера' }); }
  });
});
server.listen(PORT, HOST, () => console.log('Последние Врата: сервер на ' + HOST + ':' + PORT + ', данные в ' + DATA));
