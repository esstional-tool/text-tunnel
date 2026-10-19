// text-tunnel: 저장소 없는 실시간 중계 서버 (의존성 0)
// - 방 이름 + 방 비밀번호로 들어간다. 같은 방에 접속해 있는 기기끼리만 주고받는다.
// - 마지막 사람이 나가면 방은 메시지·파일과 함께 사라진다. 디스크에는 아무것도 쓰지 않는다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;
const MAX_MB = Number(process.env.MAX_MB) || 100;        // 파일 하나 상한
const MEM_MB = Number(process.env.MEM_MB) || 300;        // 서버가 들고 있는 파일 전체 상한
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 50;
const FILE_TTL = 10 * 60 * 1000;
const GRACE = 30 * 1000;            // 연결이 끊긴 기기를 기다려 주는 시간 (화면 꺼짐·새로고침)
const CHUNK_MAX = 16 * 1024 * 1024; // 브라우저는 8MB씩 보낸다. 여유를 둔 상한
const PUB = path.join(__dirname, 'public');

const rooms = new Map();  // roomKey -> { name, salt, hash, members: Map<token, Member>, files: Map, uploads: Map }
const tokens = new Map(); // token -> roomKey
let fileBytes = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/* ── 방 ─────────────────────────────────── */
const roomKey = (name) => name.trim().toLowerCase();
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);

function destroyRoom(key) {
  const room = rooms.get(key);
  if (!room) return;
  for (const [t, m] of room.members) { tokens.delete(t); clearTimeout(m.timer); m.res?.end(); }
  for (const f of room.files.values()) { clearTimeout(f.timer); fileBytes -= f.buf.length; }
  for (const u of room.uploads.values()) clearTimeout(u.timer);
  rooms.delete(key);
  console.log(`방 폭파: ${room.name} (남은 방 ${rooms.size}개)`);
}

function removeMember(room, token) {
  const m = room.members.get(token);
  if (!m) return;
  clearTimeout(m.timer);
  m.res?.end();
  room.members.delete(token);
  tokens.delete(token);
  if (!room.members.size) destroyRoom(roomKey(room.name));
  else presence(room);
}

function broadcast(room, ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const m of room.members.values()) m.res?.write(line);
}

function presence(room) {
  const users = [...room.members].filter(([, m]) => m.res).map(([, m]) => ({ id: m.id, name: m.name }));
  broadcast(room, { type: 'presence', room: room.name, users });
}

function auth(url) {
  const token = url.searchParams.get('token') || '';
  const room = rooms.get(tokens.get(token));
  const member = room?.members.get(token);
  return member ? { room, member, token } : null;
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
    'Cache-Control': 'private, max-age=600',
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

/* ── 라우트 ─────────────────────────────── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!p.startsWith('/api/')) return serveStatic(url, res);

  // 방 만들기 / 들어가기: { room, password, name, create }
  if (p === '/api/join' && req.method === 'POST') {
    return readBody(req, 4096, (err, body) => {
      let j;
      try { j = JSON.parse(body); } catch { return send(res, 400, { error: '잘못된 요청이에요' }); }
      const name = String(j.room || '').trim().slice(0, 30);
      const pw = String(j.password || '');
      const nick = String(j.name || '').trim().slice(0, 20) || '기기';
      if (!name) return send(res, 400, { error: '방 이름을 입력하세요' });
      if (pw.length < 4) return send(res, 400, { error: '비밀번호는 4자 이상이어야 해요' });

      const key = roomKey(name);
      let room = rooms.get(key);
      if (j.create) {
        if (room) return send(res, 409, { error: '이미 있는 방 이름이에요. 들어가기를 눌러 주세요' });
        if (rooms.size >= MAX_ROOMS) return send(res, 429, { error: '서버에 방이 너무 많아요. 잠시 뒤에 다시 해 주세요' });
        const salt = crypto.randomBytes(16);
        room = { name, salt, hash: hashPw(pw, salt), members: new Map(), files: new Map(), uploads: new Map() };
        rooms.set(key, room);
        console.log(`방 생성: ${name} (방 ${rooms.size}개)`);
      } else {
        if (!room) return send(res, 404, { error: '그런 방이 없어요. 이름을 확인하거나 새로 만들어 주세요' });
        if (!crypto.timingSafeEqual(hashPw(pw, room.salt), room.hash)) return send(res, 403, { error: '비밀번호가 맞지 않아요' });
      }

      const token = crypto.randomBytes(24).toString('base64url');
      const member = { id: crypto.randomUUID(), name: nick, res: null, timer: null };
      // 아무도 연결하지 않으면 GRACE 뒤에 정리
      member.timer = setTimeout(() => removeMember(room, token), GRACE);
      room.members.set(token, member);
      tokens.set(token, key);
      send(res, 200, { token, id: member.id, room: room.name });
    });
  }

  const a = auth(url);
  if (!a) return send(res, 401, '방이 사라졌거나 다시 들어와야 해요');
  const { room, member, token } = a;

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clearTimeout(member.timer);
    member.res?.end(); // 같은 기기가 재접속하면 이전 연결을 정리
    member.res = res;
    presence(room);
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

  if (p === '/api/ping') return send(res, 200, 'ok');

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
      broadcast(room, { type: 'msg', mid: crypto.randomUUID(), from: member.id, name: member.name, text: m.text, at: Date.now() });
      send(res, 200, 'ok');
    });
  }

  // 파일은 8MB 조각으로 순서대로 올라온다 (터널·프록시의 요청 크기 제한을 피하려고)
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
        mime: req.headers['content-type'] || 'application/octet-stream',
        timer: setTimeout(() => room.uploads.delete(uid), FILE_TTL),
      };
      room.uploads.set(uid, up);
    }
    if (!up || up.total !== total || up.received !== offset) return send(res, 409, '업로드 순서가 어긋났어요. 다시 보내 주세요');

    return readBody(req, Math.min(CHUNK_MAX, total - offset), (err, buf) => {
      if (err) { clearTimeout(up.timer); room.uploads.delete(uid); return send(res, 413, 'chunk too large'); }
      if (!rooms.has(roomKey(room.name))) return send(res, 410, '방이 사라졌어요');
      up.chunks.push(buf);
      up.received += buf.length;
      if (up.received < up.total) return send(res, 200, 'more');

      clearTimeout(up.timer);
      room.uploads.delete(uid);
      const fid = crypto.randomUUID();
      const file = { buf: Buffer.concat(up.chunks), mime: up.mime, name: up.name };
      fileBytes += file.buf.length;
      file.timer = setTimeout(() => { room.files.delete(fid); fileBytes -= file.buf.length; }, FILE_TTL);
      room.files.set(fid, file);
      broadcast(room, { type: 'file', mid: crypto.randomUUID(), fid, fname: file.name, mime: file.mime, size: file.buf.length, from: member.id, name: member.name, at: Date.now() });
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
  for (const nets of Object.values(require('os').networkInterfaces()))
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) console.log(`같은 와이파이에서: http://${n.address}:${PORT}`);
});
