// 원격조종 (이슈 #17, #21) — 메신저와 분리된 모듈. 서버의 /api/remote/* 만 담당한다.
//
// 누가 누구와 연결되나
//   에이전트  = 조종당하는 PC 에서 도는 프로그램(agent/). 메신저의 "새 기기 연결" 코드로 같은 짝 열쇠를 받아 둔다
//   보는 사람 = 같은 열쇠를 가진 브라우저(메신저 앱). 열쇠가 있어도 **PIN 을 통과해야** 화면을 받는다
//
// PIN (이슈 #21): 조종당하는 PC 의 주인이 에이전트에서 정하고, **맞는지도 에이전트가 직접 확인한다.**
//   서버는 PIN 을 저장하지 않는다 — 보는 사람이 보낸 PIN 을 에이전트에 그대로 전달하고, 에이전트의 판정만 보는 사람에게 돌려준다.
//   서버가 지키는 것: 인증 안 된 사람에게는 화면도 화면 알림도 주지 않는다 / 틀린 시도 횟수 제한(에이전트가 이상해도 막히게)
//
// 조종 (이슈 #23): 마우스·키보드 입력. 보기와 별개의 허용이 필요하다.
//   에이전트(주인)가 "조종 허용"을 켜 둬야 하고(agent/control), 보는 사람이 "조종 켜기"(view/control)를 눌러야 하며,
//   PIN 을 통과한 사람의 입력만 에이전트로 전달한다(view/input). 입력 내용은 저장·기록하지 않고 그대로 전달만 한다.
//
// 바뀐 부분만 (이슈 #24): 에이전트는 화면을 칸으로 나눠 바뀐 칸만 "조각"(patch)으로 보내고, 가끔 전체 화면 "키 프레임"(key)을 보낸다.
//   서버는 이미지를 디코딩하지 않는다. 키 프레임 1장 + 그 뒤 조각들(번호 순서)만 메모리에 짧게 들고 있다가,
//   보는 사람이 "마지막으로 받은 번호(since)" 이후 것만 한 번에 묶어 준다. 너무 뒤처졌거나 처음이면 키 프레임부터.
//   조각이 키 프레임보다 많이 쌓이면 에이전트에게 새 키 프레임을 요청한다 (응답 본문 'key').
//   묶음 형식(큰 값은 big-endian): 'TTF1' | u32 번호 | u16 화면가로 | u16 화면세로 | u16 개수 | 개수 × { u16 x, u16 y, u16 w, u16 h, u32 길이, 이미지 }
//
// 기록 원칙: 화면 프레임은 **최신 한 장만 메모리에 덮어쓴다.** 디스크·로그에 아무것도 쓰지 않는다 (PIN 포함).
// 전송: 기존 SSE + POST 재사용 (의존성 0).
//   에이전트 → 서버   POST /api/remote/frame   (JPEG 한 장)
//   서버 → 인증된 보는 쪽   SSE 로 "새 프레임 번호"만 알림, 보는 쪽이 GET /api/remote/frame 으로 최신 한 장을 가져감
//   서버 → 에이전트   SSE 로 "지금 보는 사람 수(인증된 사람만)" 와 "PIN 확인 요청" — 0 이면 화면을 찍지도 않는다
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const PIN_RE = /^[0-9]{6,12}$/;
const FRAME_MAX = 4 * 1024 * 1024;
const PATCH_MAX_RECTS = 32, PATCH_BYTES_SOFT = 256 * 1024, PATCH_BYTES_HARD = 6 * 1024 * 1024, PATCH_COUNT_SOFT = 400; // 조각이 이만큼 쌓이면 새 키 프레임 요청 / 이 이상이면 버리고 키 프레임을 기다림
const TOKEN_GRACE = 30 * 1000;       // SSE 를 안 연 입장권은 이 시간 뒤 버림
const VIEWER_FAILS = 5;               // 보는 사람(입장권) 하나당 틀릴 수 있는 횟수
const NS_FAILS = 10, NS_WINDOW = 10 * 60 * 1000; // 같은 열쇠 전체: 10분에 10번
const INPUT_BODY = 16 * 1024, INPUT_BATCH = 120, INPUT_PER_SEC = 600; // 입력 한 묶음 크기·개수, 보는 사람당 초당 한도

// 이미지(JPEG·PNG) 첫 바이트만 확인 — 서버는 디코딩하지 않는다
const isImage = (b) => b.length > 8 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47));
// 에이전트가 보낸 조각 묶음 검사: u8 개수 | 개수 × { u16 x, y, w, h, u32 길이, 이미지 } — 길이 합이 정확히 맞고 화면 안이어야 한다
function parseBundle(buf, W, H) {
  if (buf.length < 1) return null;
  const n = buf[0]; if (n < 1 || n > PATCH_MAX_RECTS) return null;
  let o = 1; const rects = [];
  for (let i = 0; i < n; i++) {
    if (o + 12 > buf.length) return null;
    const x = buf.readUInt16BE(o), y = buf.readUInt16BE(o + 2), w = buf.readUInt16BE(o + 4), h = buf.readUInt16BE(o + 6), len = buf.readUInt32BE(o + 8); o += 12;
    if (!w || !h || x + w > W || y + h > H || !len || o + len > buf.length) return null;
    const img = buf.subarray(o, o + len); if (!isImage(img)) return null;
    rects.push({ x, y, w, h, buf: Buffer.from(img) }); o += len; // 복사해 둔다 (요청 버퍼를 계속 붙잡지 않게)
  }
  return o === buf.length ? rects : null;
}

// 입력 이벤트 한 개를 검사해 정리한다 (모르는 모양은 버린다). 좌표는 화면 비율 0~1
const num = (x, lo, hi) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null);
function cleanInput(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.t === 'm') { const x = num(e.x, 0, 1), y = num(e.y, 0, 1); return x === null || y === null ? null : { t: 'm', x, y }; }
  if (e.t === 'd' || e.t === 'u') {
    const x = num(e.x, 0, 1), y = num(e.y, 0, 1), b = e.b | 0;
    return x === null || y === null || b < 0 || b > 2 ? null : { t: e.t, x, y, b };
  }
  if (e.t === 'w') { const dx = num(e.dx, -2000, 2000), dy = num(e.dy, -2000, 2000); return dx === null || dy === null ? null : { t: 'w', dx: Math.round(dx), dy: Math.round(dy) }; }
  if (e.t === 'k') { const vk = e.vk | 0; return vk < 1 || vk > 254 ? null : { t: 'k', vk, d: e.d ? 1 : 0, e: e.e ? 1 : 0 }; }
  if (e.t === 'r') return { t: 'r' }; // 눌려 있던 키·버튼 모두 떼기
  return null;
}

module.exports = function createRemote({ readBody, send, crypto, authTimeoutMs = 8000 }) {
  const sessions = new Map(); // 네임스페이스(열쇠 해시) -> { agent, viewers: Map, frame, seq, fails: [시각] }
  const tokens = new Map();   // 토큰 -> { ns, role, timer }

  const nsOf = (key) => crypto.createHash('sha256').update('remote:' + key).digest('hex'); // 메신저 방 번호와 다른 값

  function sse(req, res, onClose) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); onClose(); });
  }
  const push = (res, ev) => res?.write(`data: ${JSON.stringify(ev)}\n\n`);

  function session(ns) {
    let s = sessions.get(ns);
    if (!s) { s = { ns, agent: null, viewers: new Map(), frame: null, key: null, patches: [], patchBytes: 0, seq: 0, fails: [] }; sessions.set(ns, s); }
    return s;
  }
  function gc(s) { if (!s.agent && !s.viewers.size) sessions.delete(s.ns); } // 다 나가면 프레임까지 사라진다

  const okViewers = (s) => [...s.viewers.values()].filter((v) => v.ok);
  const controllers = (s) => okViewers(s).filter((v) => v.control).length;
  const notifyAgent = (s) => push(s.agent?.res, { type: 'viewers', count: okViewers(s).length, controllers: controllers(s) }); // 인증된 사람만 센다
  const ctlState = (s, v) => ({ type: 'control', allowed: !!s.agent?.control, on: !!(v.control && s.agent?.control) });
  const notifyControl = (s) => { for (const v of s.viewers.values()) push(v.res, ctlState(s, v)); };
  const notifyAll = (s, ev) => { for (const v of s.viewers.values()) push(v.res, ev); };           // 에이전트 온라인 여부 등 (인증 전에도)
  const notifyOk = (s, ev) => { for (const v of okViewers(s)) push(v.res, ev); };                  // 화면 알림은 인증된 사람에게만

  function issue(ns, role) {
    const token = crypto.randomBytes(24).toString('base64url');
    const t = { ns, role, timer: setTimeout(() => dropToken(token), TOKEN_GRACE) };
    tokens.set(token, t);
    return token;
  }
  function dropToken(token) {
    const t = tokens.get(token);
    if (!t) return;
    clearTimeout(t.timer);
    tokens.delete(token);
    const s = sessions.get(t.ns);
    if (!s) return;
    if (t.role === 'agent' && s.agent?.token === token) {
      s.agent.res?.end(); s.agent = null; s.frame = null; s.key = null; s.patches = []; s.patchBytes = 0;
      // 에이전트가 다시 시작되면 PIN 이 바뀌었을 수 있다 → 모두 다시 인증
      for (const v of s.viewers.values()) { clearTimeout(v.pendingTimer); v.pendingTimer = null; v.ok = false; v.control = false; }
      notifyAll(s, { type: 'agent', online: false });
      notifyControl(s);
    } else if (t.role === 'viewer' && s.viewers.has(token)) {
      clearTimeout(s.viewers.get(token).pendingTimer);
      s.viewers.get(token).res?.end(); s.viewers.delete(token);
      notifyAgent(s);
    }
    gc(s);
  }
  const auth = (url, role) => {
    const token = url.searchParams.get('token') || '';
    const t = tokens.get(token);
    return t && t.role === role ? { token, s: sessions.get(t.ns), t } : null;
  };

  // 처리했으면 true. server.js 의 라우터에서 /api/remote/ 로 시작할 때만 부른다
  return function handle(req, res, url) {
    const p = url.pathname;
    const body = (limit, cb) => readBody(req, limit, (err, buf) => (err ? send(res, 413, 'too large') : cb(buf)));
    const json = (cb) => body(4096, (buf) => { let j; try { j = JSON.parse(buf); } catch { return send(res, 400, { error: '잘못된 요청이에요' }); } cb(j || {}); });

    // ── 입장 ───────────────────────────────────────
    if (p === '/api/remote/agent/join' && req.method === 'POST') {
      json((j) => {
        if (!KEY_RE.test(String(j.key || ''))) return send(res, 400, { error: '연결 정보가 올바르지 않아요' });
        const s = session(nsOf(j.key));
        if (s.agent) dropToken(s.agent.token); // 같은 에이전트가 다시 들어오면 이전 연결을 정리
        const token = issue(s.ns, 'agent');
        const s2 = session(s.ns); // dropToken 이 세션을 지웠을 수 있어서 다시 확인
        s2.agent = { token, name: String(j.name || 'PC').slice(0, 30), res: null };
        send(res, 200, { token });
      });
      return true;
    }
    if (p === '/api/remote/view/join' && req.method === 'POST') {
      json((j) => {
        if (!KEY_RE.test(String(j.key || ''))) return send(res, 400, { error: '연결 정보가 올바르지 않아요' });
        const s = session(nsOf(j.key));
        const token = issue(s.ns, 'viewer');
        s.viewers.set(token, { res: null, vid: crypto.randomBytes(6).toString('hex'), ok: false, fails: 0, pendingTimer: null, control: false, bucket: INPUT_PER_SEC, bucketAt: Date.now() });
        send(res, 200, { token, agentOnline: !!s.agent?.res, needPin: true });
      });
      return true;
    }

    // ── PIN (이슈 #21) ─────────────────────────────
    // 보는 사람 → 서버 → 에이전트(확인) → 서버 → 보는 사람. 서버는 PIN 을 저장하지 않고 판정만 전달한다
    if (p === '/api/remote/view/auth' && req.method === 'POST') {
      const a = auth(url, 'viewer');
      if (!a || !a.s?.viewers.has(a.token)) { send(res, 401, '다시 연결해야 해요'); return true; }
      json((j) => {
        const s = a.s, v = s.viewers.get(a.token);
        if (!PIN_RE.test(String(j.pin || ''))) return send(res, 400, { error: 'PIN 은 6~12자리 숫자예요' });
        if (v.ok) return send(res, 200, { status: 'ok' });
        if (!s.agent?.res) return send(res, 409, { error: '원격 PC 의 에이전트가 꺼져 있어요' });
        const now = Date.now();
        s.fails = s.fails.filter((t) => now - t < NS_WINDOW);
        if (v.fails >= VIEWER_FAILS || s.fails.length >= NS_FAILS) { // 에이전트가 이상해도 서버가 막는다
          push(v.res, { type: 'auth', ok: false, locked: true, error: '너무 많이 틀려서 잠시 막혔어요' });
          return send(res, 429, { error: '너무 많이 틀렸어요' });
        }
        if (v.pendingTimer) return send(res, 409, { error: '확인하는 중이에요' });
        v.pendingTimer = setTimeout(() => { // 에이전트가 답하지 않는 경우
          v.pendingTimer = null;
          push(v.res, { type: 'auth', ok: false, error: '원격 PC 가 응답하지 않아요' });
        }, authTimeoutMs);
        push(s.agent.res, { type: 'auth', vid: v.vid, pin: String(j.pin) });
        send(res, 200, { status: 'checking' });
      });
      return true;
    }
    if (p === '/api/remote/agent/auth' && req.method === 'POST') {
      const a = auth(url, 'agent');
      if (!a || a.s?.agent?.token !== a.token) { send(res, 401, '다시 연결해야 해요'); return true; }
      json((j) => {
        const s = a.s;
        const v = [...s.viewers.values()].find((x) => x.vid === String(j.vid || ''));
        if (!v) return send(res, 404, 'gone');
        clearTimeout(v.pendingTimer); v.pendingTimer = null;
        if (j.ok === true) {
          v.ok = true;
          push(v.res, { type: 'auth', ok: true });
          if (s.frame) push(v.res, { type: 'frame', seq: s.frame.seq, w: s.frame.w, h: s.frame.h });
          notifyAgent(s);
        } else {
          v.fails++; s.fails.push(Date.now());
          push(v.res, { type: 'auth', ok: false, code: String(j.code || ''), left: Math.max(0, Number(j.left) || 0), locked: !!j.locked, lockedUntil: Number(j.lockedUntil) || 0 });
        }
        send(res, 200, 'ok');
      });
      return true;
    }

    // ── 조종 (이슈 #23) ────────────────────────────
    // 에이전트가 "이 PC 는 조종을 허용한다/아니다" 를 알린다. 끄면 모든 보는 사람의 조종이 즉시 꺼진다
    if (p === '/api/remote/agent/control' && req.method === 'POST') {
      const a = auth(url, 'agent');
      if (!a || a.s?.agent?.token !== a.token) { send(res, 401, '다시 연결해야 해요'); return true; }
      json((j) => {
        const s = a.s;
        if (!s.agent || s.agent.token !== a.token) return send(res, 409, 'gone'); // 본문을 읽는 사이 에이전트가 사라졌다
        s.agent.control = j.allowed === true;
        if (!s.agent.control) for (const v of s.viewers.values()) v.control = false;
        notifyControl(s); notifyAgent(s);
        send(res, 200, 'ok');
      });
      return true;
    }
    // 보는 사람이 "조종 켜기/끄기"
    if (p === '/api/remote/view/control' && req.method === 'POST') {
      const a = auth(url, 'viewer');
      if (!a || !a.s?.viewers.has(a.token)) { send(res, 401, '다시 연결해야 해요'); return true; }
      json((j) => {
        const s = a.s, v = s.viewers.get(a.token);
        if (!v.ok) return send(res, 403, { error: 'PIN 을 먼저 확인해야 해요' });
        if (j.on === true && !s.agent?.control) return send(res, 409, { error: '원격 PC 에서 조종이 허용되어 있지 않아요 (트레이 메뉴 → 원격 조종 허용)' });
        v.control = j.on === true;
        push(v.res, ctlState(s, v)); notifyAgent(s);
        send(res, 200, ctlState(s, v));
      });
      return true;
    }
    // 입력 묶음. 서버는 모양만 검사해 에이전트로 그대로 전달한다 (저장·기록 없음)
    if (p === '/api/remote/view/input' && req.method === 'POST') {
      const a = auth(url, 'viewer');
      if (!a || !a.s?.viewers.has(a.token)) { send(res, 401, '다시 연결해야 해요'); return true; }
      const s = a.s, v = s.viewers.get(a.token);
      if (!v.ok) { send(res, 403, 'PIN 을 먼저 확인해야 해요'); return true; }
      if (!v.control || !s.agent?.control || !s.agent.res) { send(res, 409, '조종이 꺼져 있어요'); return true; }
      body(INPUT_BODY, (buf) => {
        let j; try { j = JSON.parse(buf); } catch { return send(res, 400, 'bad json'); }
        const ag = s.agent; // 본문을 읽는 사이 에이전트가 사라지거나 조종이 꺼졌을 수 있어 다시 확인한다
        if (!ag?.res || !ag.control || !s.viewers.has(a.token) || !v.control) return send(res, 409, '조종이 꺼져 있어요');
        const list = Array.isArray(j?.ev) ? j.ev.slice(0, INPUT_BATCH) : [];
        const now = Date.now();
        v.bucket = Math.min(INPUT_PER_SEC, v.bucket + (now - v.bucketAt) / 1000 * INPUT_PER_SEC); v.bucketAt = now;
        v.bucket -= 1; // 요청 자체에도 토큰 1개 (잘못된 이벤트만 담아 계속 보내는 것도 막는다)
        const ev = [];
        for (const e of list) {
          const c = cleanInput(e); if (!c) continue;
          const release = c.t === 'r' || (c.t === 'k' && !c.d) || c.t === 'u'; // 떼기는 한도에 걸려 버려지면 키가 눌린 채 남으므로 항상 통과
          if (!release) { if (v.bucket < 1) continue; v.bucket -= 1; }
          ev.push(c);
        }
        if (ev.length) push(ag.res, { type: 'input', vid: v.vid, ev });
        send(res, 200, { sent: ev.length, dropped: list.length - ev.length });
      });
      return true;
    }

    // ── 실시간 알림 ────────────────────────────────
    if (p === '/api/remote/agent/events' && req.method === 'GET') {
      const a = auth(url, 'agent');
      if (!a || a.s?.agent?.token !== a.token) { send(res, 401, '다시 연결해야 해요'); return true; }
      clearTimeout(a.t.timer);
      a.s.agent.res = res;
      sse(req, res, () => dropToken(a.token));
      a.s.agent.control = false; // 에이전트가 허용 상태를 알려 올 때까지는 꺼짐으로 본다
      notifyAll(a.s, { type: 'agent', online: true, name: a.s.agent.name });
      notifyAgent(a.s);
      return true;
    }
    if (p === '/api/remote/view/events' && req.method === 'GET') {
      const a = auth(url, 'viewer');
      if (!a || !a.s?.viewers.has(a.token)) { send(res, 401, '다시 연결해야 해요'); return true; }
      clearTimeout(a.t.timer);
      const v = a.s.viewers.get(a.token);
      v.res = res;
      sse(req, res, () => dropToken(a.token));
      push(res, { type: 'agent', online: !!a.s.agent?.res, name: a.s.agent?.name });
      push(res, ctlState(a.s, v));
      if (v.ok && a.s.frame) push(res, { type: 'frame', seq: a.s.frame.seq, w: a.s.frame.w, h: a.s.frame.h });
      notifyAgent(a.s);
      return true;
    }

    // ── 화면 ───────────────────────────────────────
    if (p === '/api/remote/frame' && req.method === 'POST') {
      const a = auth(url, 'agent');
      if (!a || a.s?.agent?.token !== a.token) { send(res, 401, '다시 연결해야 해요'); return true; }
      body(FRAME_MAX, (buf) => {
        const s = a.s;
        if (!s.agent || s.agent.token !== a.token) return send(res, 409, 'gone');
        const kind = url.searchParams.get('kind') === 'patch' ? 'patch' : 'key';
        const w = Math.min(8192, Number(url.searchParams.get('w')) || 0), h = Math.min(8192, Number(url.searchParams.get('h')) || 0);
        if (!okViewers(s).length) return send(res, 200, 'idle'); // 인증된 보는 사람이 없으면 받지 않는다
        if (kind === 'key') {
          if (!isImage(buf) || !w || !h) return send(res, 400, '이미지가 아니에요');
          s.key = { buf, seq: ++s.seq, w, h };        // 키 프레임이 오면 이전 키·조각은 모두 버려진다
          s.patches = []; s.patchBytes = 0;
        } else {
          if (!s.key || s.key.w !== w || s.key.h !== h) return send(res, 200, 'key'); // 기준이 없거나 화면 크기가 바뀜 → 키 프레임부터
          const rects = parseBundle(buf, w, h);
          if (!rects) return send(res, 400, '조각 묶음이 올바르지 않아요');
          const seq = ++s.seq;
          for (const r of rects) { s.patches.push({ seq, ...r }); s.patchBytes += r.buf.length; }
          if (s.patchBytes > PATCH_BYTES_HARD) { s.key = null; s.patches = []; s.patchBytes = 0; return send(res, 200, 'key'); } // 안전 상한: 버리고 키 프레임을 기다림
        }
        s.frame = { seq: s.seq, w, h };
        notifyOk(s, { type: 'frame', seq: s.seq, w, h });
        const wantKey = s.patchBytes > Math.max(PATCH_BYTES_SOFT, s.key.buf.length * 2) || s.patches.length > PATCH_COUNT_SOFT;
        send(res, 200, wantKey ? 'key' : 'ok');
      });
      return true;
    }
    if (p === '/api/remote/frame' && req.method === 'GET') {
      const a = auth(url, 'viewer');
      if (!a || !a.s?.viewers.has(a.token)) { send(res, 401, '다시 연결해야 해요'); return true; }
      if (!a.s.viewers.get(a.token).ok) { send(res, 403, 'PIN 을 먼저 확인해야 해요'); return true; } // 인증 전에는 화면을 주지 않는다
      const s = a.s, k = s.key;
      if (!k) { send(res, 404, '아직 화면이 없어요'); return true; }
      if (!url.searchParams.has('since')) { // 이전 방식: 가장 최근 키 프레임 한 장 (이미지 그대로)
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': k.buf.length, 'Cache-Control': 'no-store', 'X-Frame-Seq': k.seq });
        res.end(k.buf);
        return true;
      }
      const since = Number(url.searchParams.get('since')) || 0;
      if (since >= s.seq) { res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Frame-Seq': s.seq }); res.end(); return true; } // 새 것이 없음
      const rects = since < k.seq ? [{ x: 0, y: 0, w: k.w, h: k.h, buf: k.buf }, ...s.patches] : s.patches.filter((p) => p.seq > since); // 뒤처졌거나 처음이면 키부터
      const head = Buffer.alloc(16); head.write('TTF1', 0, 'latin1'); head.writeUInt32BE(s.seq, 4); head.writeUInt16BE(k.w, 8); head.writeUInt16BE(k.h, 10); head.writeUInt16BE(rects.length, 12);
      const parts = [head.subarray(0, 14)];
      for (const r of rects) { const rh = Buffer.alloc(12); rh.writeUInt16BE(r.x, 0); rh.writeUInt16BE(r.y, 2); rh.writeUInt16BE(r.w, 4); rh.writeUInt16BE(r.h, 6); rh.writeUInt32BE(r.buf.length, 8); parts.push(rh, r.buf); }
      const out = Buffer.concat(parts);
      res.writeHead(200, { 'Content-Type': 'application/x-tt-frames', 'Content-Length': out.length, 'Cache-Control': 'no-store', 'X-Frame-Seq': s.seq });
      res.end(out);
      return true;
    }

    if (p === '/api/remote/ping') {
      const a = auth(url, 'viewer') || auth(url, 'agent');
      send(res, a ? 200 : 401, a ? 'ok' : '다시 연결해야 해요');
      return true;
    }
    if (p === '/api/remote/leave' && req.method === 'POST') {
      const token = url.searchParams.get('token') || '';
      if (tokens.has(token)) dropToken(token);
      send(res, 200, 'ok');
      return true;
    }
    return false;
  };
};
