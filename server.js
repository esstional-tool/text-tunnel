// text-tunnel: 저장소 없는 실시간 중계 서버 (의존성 0)
// - 두 기기가 처음 한 번 QR/6자리 코드로 짝을 맺으면, 같은 비밀 열쇠를 각자 브라우저에 보관한다.
// - 앱을 열면 열쇠의 해시로 방에 들어간다. 방은 최대 2대, 둘 다 나가면 메시지·파일과 함께 사라진다.
// - 서버는 열쇠도, 대화도 디스크나 로그에 남기지 않는다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;
const MAX_MB = Number(process.env.MAX_MB) || 100;        // 파일 하나 상한
const MEM_MB = Number(process.env.MEM_MB) || 300;        // 서버가 들고 있는 파일 전체 상한
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 50;
const ROOM_SIZE = 2;
const FILE_TTL = 10 * 60 * 1000;
const PAIR_TTL = 5 * 60 * 1000;     // 짝 코드 유효 시간
const GRACE = 30 * 1000;            // 연결이 끊긴 기기를 기다려 주는 시간 (화면 꺼짐·새로고침)
const STALE = (Number(process.env.STALE_SEC) || 90) * 1000;          // 이만큼 살아 있다는 신호가 없으면, 방이 꽉 찼을 때 자리를 내준다
const CHUNK_MAX = 16 * 1024 * 1024; // 브라우저는 8MB씩 보낸다. 여유를 둔 상한
const REPLAY = (Number(process.env.REPLAY_SEC) || 120) * 1000; // 끊겼다 다시 연결된 기기에 다시 보내 줄 최근 이벤트 보관 시간 (메모리만)
const REPLAY_MAX = 300;                                          // 방마다 최대 보관 개수
const PUB = path.join(__dirname, 'public');

const rooms = new Map();  // roomId -> { members: Map<token, Member>, files: Map, uploads: Map }
const tokens = new Map(); // token -> roomId
const pairs = new Map();  // 6자리 코드 -> { key, timer }
const misses = new Map(); // ip -> { n, until } 틀린 코드 시도 제한
let fileBytes = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/* ── 방 ─────────────────────────────────── */
function destroyRoom(id) {
  const room = rooms.get(id);
  if (!room) return;
  for (const [t, m] of room.members) { tokens.delete(t); clearTimeout(m.timer); m.res?.end(); }
  for (const f of room.files.values()) { clearTimeout(f.timer); fileBytes -= f.buf.length; }
  for (const u of room.uploads.values()) clearTimeout(u.timer);
  rooms.delete(id);
}

function removeMember(room, token) {
  const m = room.members.get(token);
  if (!m) return;
  clearTimeout(m.timer);
  m.res?.end();
  room.members.delete(token);
  tokens.delete(token);
  if (!room.members.size) destroyRoom(room.id);
  else presence(room);
}

// 메시지·파일·대화 지우기는 다시 보내 줄 수 있게 번호를 붙여 방의 최근 이벤트 줄(log)에 보관한다.
// 번호는 '방 시작 표시:순번' — 방이 사라졌다 새로 생기면 시작 표시가 달라져 옛 번호와 섞이지 않는다
const REPLAYABLE = new Set(['msg', 'file', 'clear']);
function broadcast(room, ev) {
  let head = '';
  if (REPLAYABLE.has(ev.type)) {
    ev.mid ??= crypto.randomUUID();
    head = `id: ${room.epoch}:${++room.seq}\n`;
    if (ev.type === 'clear') room.log = []; // 지운 대화가 다시 보내지는 일이 없게
  }
  const line = `${head}data: ${JSON.stringify(ev)}\n\n`;
  if (head) { room.log.push({ seq: room.seq, at: Date.now(), line }); trimLog(room); }
  for (const m of room.members.values()) m.res?.write(line);
}

function trimLog(room) {
  const old = Date.now() - REPLAY;
  while (room.log.length && (room.log[0].at < old || room.log.length > REPLAY_MAX)) room.log.shift();
}

// 다시 연결한 기기에, 마지막으로 받은 번호(last) 이후의 이벤트만 다시 보낸다.
// 처음 여는 기기(last 없음)나 다른 방의 번호면 보관 중인 것 전부 (= 앱을 닫아 둔 사이 온 메시지)
function replay(room, res, last) {
  trimLog(room);
  const [epoch, seq] = String(last || '').split(':');
  const after = epoch === room.epoch ? Number(seq) || 0 : 0;
  for (const e of room.log) if (e.seq > after) res.write(e.line);
}

function presence(room) {
  const users = [...room.members.values()].filter((m) => m.res).map((m) => ({ id: m.id, name: m.name }));
  broadcast(room, { type: 'presence', users });
}

function auth(url) {
  const token = url.searchParams.get('token') || '';
  const room = rooms.get(tokens.get(token));
  const member = room?.members.get(token);
  if (member) member.seen = Date.now(); // 앱은 20초마다 /api/ping 으로 살아 있음을 알린다
  return member ? { room, member, token } : null;
}

function dropMember(room, token) {
  const m = room.members.get(token);
  clearTimeout(m.timer); m.res?.end();
  room.members.delete(token); tokens.delete(token);
}

/* ── 짝 코드 ────────────────────────────── */
// 헷갈리는 글자(0/O, 1/I/L)를 뺀 6자리
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newCode() {
  let c;
  do c = [...crypto.randomBytes(6)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  while (pairs.has(c));
  return c;
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
function blocked(ip) {
  const m = misses.get(ip);
  return m && m.until > Date.now() && m.n >= 10;
}
function miss(ip) {
  const m = misses.get(ip);
  if (!m || m.until < Date.now()) misses.set(ip, { n: 1, until: Date.now() + 10 * 60 * 1000 });
  else m.n++;
}

/* ── HTTP 도구 ──────────────────────────── */
function readBody(req, limit, cb) {
  const chunks = [];
  let size = 0, over = false;
  req.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > limit) { over = true; cb(new Error('too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => { if (!over) cb(null, Buffer.concat(chunks)); });
  req.on('error', (e) => { if (!over) cb(e); });
}

function readJson(req, cb) {
  readBody(req, 4096, (err, body) => {
    if (err) return cb(null);
    try { cb(JSON.parse(body)); } catch { cb(null); }
  });
}

function send(res, code, body) {
  const json = typeof body === 'object';
  res.writeHead(code, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json ? JSON.stringify(body) : body);
}

function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUB, path.normalize(rel));
  if (!file.startsWith(PUB)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// 동영상은 iOS Safari가 Range 요청으로만 재생하므로 부분 응답을 지원한다.
function serveFile(f, req, res) {
  const total = f.buf.length;
  const head = {
    'Content-Type': f.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store', // 사진·동영상이 브라우저 캐시 폴더에 남지 않게
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { ...head, 'Content-Length': total }); return res.end(f.buf); }
  const start = m[1] ? Number(m[1]) : total - Number(m[2]);
  const end = m[1] && m[2] ? Number(m[2]) : total - 1;
  if (start < 0 || start >= total || end >= total || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end();
  }
  res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
  res.end(f.buf.subarray(start, end + 1));
}

/* ── 크롬 확장 zip (extension/ 폴더를 시작할 때 한 번 묶어 둔다) ─── */
// 압축 없이 저장만 하는 최소 ZIP. 크롬 '압축해제된 확장 프로그램 로드'에 쓸 폴더 하나가 나온다
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function makeZip(entries) { // [{ name, data }]
  const locals = [], centrals = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (46 << 9) | (10 << 5) | 20; // 2026-10-20
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 이름
    local.writeUInt16LE(0, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const EXT_DIR = path.join(__dirname, 'extension');
let extZip = null;
try {
  extZip = makeZip(fs.readdirSync(EXT_DIR).sort().map((f) => ({ name: `text-tunnel-cleaner/${f}`, data: fs.readFileSync(path.join(EXT_DIR, f)) })));
} catch { /* extension 폴더가 없으면 다운로드만 비활성 */ }

/* ── 라우트 ─────────────────────────────── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/text-tunnel-cleaner.zip' && extZip) {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': extZip.length, 'Content-Disposition': 'attachment; filename="text-tunnel-cleaner.zip"', 'Cache-Control': 'no-cache' });
    return res.end(extZip);
  }
  if (!p.startsWith('/api/')) return serveStatic(url, res);

  if (p === '/api/health') return send(res, 200, 'ok');

  // 짝 맺기 시작: 열쇠를 가진 기기가 6자리 코드를 받는다. { key? } — 없으면 새 열쇠를 만든다
  if (p === '/api/pair/start' && req.method === 'POST') {
    return readJson(req, (j) => {
      const key = typeof j?.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(j.key) ? j.key : crypto.randomBytes(32).toString('base64url');
      const code = newCode();
      pairs.set(code, { key, timer: setTimeout(() => pairs.delete(code), PAIR_TTL) });
      send(res, 200, { code, key, expiresIn: PAIR_TTL / 1000 });
    });
  }

  // 짝 맺기 완료: 다른 기기가 코드를 내고 열쇠를 받는다. 코드는 한 번 쓰면 사라진다
  if (p === '/api/pair/claim' && req.method === 'POST') {
    const ip = clientIp(req);
    if (blocked(ip)) return send(res, 429, { error: '코드를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요' });
    return readJson(req, (j) => {
      const code = String(j?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const pair = pairs.get(code);
      if (!pair) { miss(ip); return send(res, 404, { error: '코드가 맞지 않거나 시간이 지났어요. PC에서 새 코드를 받아 주세요' }); }
      clearTimeout(pair.timer);
      pairs.delete(code);
      send(res, 200, { key: pair.key });
    });
  }

  // 방 입장: { key, name, device } — 방 번호는 열쇠의 해시. 열쇠 자체는 어디에도 보관하지 않는다
  if (p === '/api/join' && req.method === 'POST') {
    return readJson(req, (j) => {
      const key = String(j?.key || '');
      const device = String(j?.device || '').slice(0, 64);
      const name = String(j?.name || '').trim().slice(0, 20) || '기기';
      if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !device) return send(res, 400, { error: '연결 정보가 올바르지 않아요. 다시 연결해 주세요' });
      const id = crypto.createHash('sha256').update(key).digest('hex');

      let room = rooms.get(id);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) return send(res, 429, { error: '서버가 붐벼요. 잠시 뒤에 다시 열어 주세요' });
        room = { id, members: new Map(), files: new Map(), uploads: new Map(), done: new Map(), epoch: crypto.randomBytes(4).toString('hex'), seq: 0, log: [] };
        rooms.set(id, room);
      }
      // 같은 기기가 다시 들어오면(새로고침·앱 재실행) 이전 자리를 비운다
      for (const [t, m] of room.members) if (m.device === device) dropMember(room, t);
      // 꽉 찼으면 소식이 끊긴 자리(앱 강제 종료 등으로 남은 유령)를 가장 오래된 것부터 비운다
      if (room.members.size >= ROOM_SIZE) {
        const stale = [...room.members].filter(([, m]) => Date.now() - m.seen > STALE).sort(([, a], [, b]) => a.seen - b.seen);
        if (stale.length) { dropMember(room, stale[0][0]); presence(room); }
      }
      if (room.members.size >= ROOM_SIZE) return send(res, 409, { error: '이미 두 기기가 연결돼 있어요' });

      const token = crypto.randomBytes(24).toString('base64url');
      const tag = crypto.createHash('sha256').update(device).digest('hex').slice(0, 16); // 이전 접속에서 보낸 내 메시지를 알아보는 표식 (기기 ID 자체는 상대에게 안 보임)
      const member = { id: crypto.randomUUID(), device, tag, name, res: null, timer: null, seen: Date.now() };
      member.timer = setTimeout(() => removeMember(room, token), GRACE); // 연결을 안 열면 정리
      room.members.set(token, member);
      tokens.set(token, id);
      send(res, 200, { token, id: member.id, tag, replaySec: REPLAY / 1000 });
    });
  }

  const a = auth(url);
  if (!a) return send(res, 401, '다시 연결해야 해요');
  const { room, member, token } = a;

  if (p === '/api/ping') return send(res, 200, 'ok');

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clearTimeout(member.timer);
    member.res?.end(); // 같은 탭이 재접속하면 이전 연결을 정리
    member.res = res;
    presence(room);
    // 놓친 이벤트 다시 보내기: 브라우저 자동 재연결은 Last-Event-ID 헤더, 앱이 새로 입장할 때는 ?last=
    replay(room, res, url.searchParams.get('last') || req.headers['last-event-id']);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      if (member.res !== res) return;
      member.res = null;
      presence(room);
      member.timer = setTimeout(() => removeMember(room, token), GRACE);
    });
    return;
  }

  // 대화 지우기: 서버에 남은 사진·파일과 올라오던 조각을 즉시 버리고, 양쪽 화면도 비우게 한다
  if (p === '/api/clear' && req.method === 'POST') {
    for (const f of room.files.values()) { clearTimeout(f.timer); fileBytes -= f.buf.length; }
    for (const u of room.uploads.values()) clearTimeout(u.timer);
    room.files.clear(); room.uploads.clear();
    broadcast(room, { type: 'clear', from: member.id, dev: member.tag, name: member.name, at: Date.now() });
    return send(res, 200, 'ok');
  }

  if (p === '/api/leave' && req.method === 'POST') {
    removeMember(room, token);
    return send(res, 200, 'ok');
  }

  if (p === '/api/send' && req.method === 'POST') {
    return readBody(req, 64 * 1024, (err, body) => {
      if (err) return send(res, 413, '메시지가 너무 길어요');
      let m;
      try { m = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
      if (typeof m.text !== 'string' || !m.text.trim()) return send(res, 400, 'empty');
      broadcast(room, { type: 'msg', mid: crypto.randomUUID(), from: member.id, dev: member.tag, name: member.name, text: m.text, at: Date.now() });
      send(res, 200, 'ok');
    });
  }

  // 업로드 이어 올리기: 연결이 끊겨 다시 시도하는 앱이 "어디까지 받았어?" 를 묻는다
  // 다 받았으면 done (응답만 끊긴 경우 — 다시 올려 중복되지 않게), 모르면 404 (서버 재시작 등 → 처음부터)
  if (p === '/api/upload' && req.method === 'GET') {
    const uid = url.searchParams.get('uid') || '';
    if (room.done.has(uid)) return send(res, 200, { done: true });
    const up = room.uploads.get(uid);
    return up ? send(res, 200, { received: up.received, total: up.total }) : send(res, 404, { received: 0 });
  }

  // 파일은 8MB 조각으로 순서대로 올라온다 (프록시의 요청 크기 제한을 피하려고)
  // ?uid=업로드ID&offset=시작바이트&total=전체크기&name=파일명
  if (p === '/api/upload' && req.method === 'POST') {
    const uid = url.searchParams.get('uid');
    const offset = Number(url.searchParams.get('offset'));
    const total = Number(url.searchParams.get('total'));
    if (!uid || !Number.isInteger(offset) || !Number.isInteger(total) || total <= 0) return send(res, 400, 'bad params');
    if (total > MAX_MB * 1024 * 1024) return send(res, 413, `파일은 ${MAX_MB}MB까지 보낼 수 있어요`);

    let up = room.uploads.get(uid);
    if (offset === 0 && !up) {
      if (fileBytes + total > MEM_MB * 1024 * 1024) return send(res, 507, '서버가 파일을 더 들고 있을 수 없어요. 잠시 뒤에 보내 주세요');
      up = {
        chunks: [], received: 0, total,
        name: (url.searchParams.get('name') || 'file').slice(0, 200),
        batch: /^[\w-]{1,40}$/.test(url.searchParams.get('batch') || '') ? url.searchParams.get('batch') : undefined, // 한 번에 고른 사진 묶음
        mime: req.headers['content-type'] || 'application/octet-stream',
        timer: setTimeout(() => room.uploads.delete(uid), FILE_TTL),
      };
      room.uploads.set(uid, up);
    }
    if (!up || up.total !== total || up.received !== offset) return send(res, 409, '업로드 순서가 어긋났어요. 다시 보내 주세요');

    return readBody(req, Math.min(CHUNK_MAX, total - offset), (err, buf) => {
      if (err) { clearTimeout(up.timer); room.uploads.delete(uid); return send(res, 413, 'chunk too large'); }
      if (!rooms.has(room.id)) return send(res, 410, '연결이 끝났어요');
      up.chunks.push(buf);
      up.received += buf.length;
      if (up.received < up.total) return send(res, 200, 'more');

      clearTimeout(up.timer);
      room.uploads.delete(uid);
      room.done.set(uid, true); // 마지막 응답이 끊겨도 다시 시도하는 앱이 "다 받았다" 를 알 수 있게 (10분)
      setTimeout(() => room.done.delete(uid), FILE_TTL);
      const fid = crypto.randomUUID();
      const file = { buf: Buffer.concat(up.chunks), mime: up.mime, name: up.name };
      fileBytes += file.buf.length;
      file.timer = setTimeout(() => { room.files.delete(fid); fileBytes -= file.buf.length; }, FILE_TTL);
      room.files.set(fid, file);
      broadcast(room, { type: 'file', mid: crypto.randomUUID(), fid, fname: file.name, mime: file.mime, size: file.buf.length, batch: up.batch, from: member.id, dev: member.tag, name: member.name, at: Date.now() });
      send(res, 200, 'done');
    });
  }

  if (p.startsWith('/api/file/') && req.method === 'GET') {
    const f = room.files.get(p.slice(10));
    if (!f) return send(res, 410, '만료된 파일이에요');
    return serveFile(f, req, res);
  }

  send(res, 405, 'method not allowed');
});

server.listen(PORT, () => {
  console.log(`text-tunnel 실행 중: http://localhost:${PORT}`);
  if (process.env.RENDER) return; // Render 안에서는 내부 주소라 의미 없음
  for (const nets of Object.values(require('os').networkInterfaces()))
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) console.log(`같은 와이파이에서: http://${n.address}:${PORT}`);
});
