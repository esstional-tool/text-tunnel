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
// 기록 원칙: 화면 프레임은 **최신 한 장만 메모리에 덮어쓴다.** 디스크·로그에 아무것도 쓰지 않는다 (PIN 포함).
// 전송: 기존 SSE + POST 재사용 (의존성 0).
//   에이전트 → 서버   POST /api/remote/frame   (JPEG 한 장)
//   서버 → 인증된 보는 쪽   SSE 로 "새 프레임 번호"만 알림, 보는 쪽이 GET /api/remote/frame 으로 최신 한 장을 가져감
//   서버 → 에이전트   SSE 로 "지금 보는 사람 수(인증된 사람만)" 와 "PIN 확인 요청" — 0 이면 화면을 찍지도 않는다
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const PIN_RE = /^[0-9]{6,12}$/;
const FRAME_MAX = 4 * 1024 * 1024;
const TOKEN_GRACE = 30 * 1000;       // SSE 를 안 연 입장권은 이 시간 뒤 버림
const VIEWER_FAILS = 5;               // 보는 사람(입장권) 하나당 틀릴 수 있는 횟수
const NS_FAILS = 10, NS_WINDOW = 10 * 60 * 1000; // 같은 열쇠 전체: 10분에 10번

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
    if (!s) { s = { ns, agent: null, viewers: new Map(), frame: null, seq: 0, fails: [] }; sessions.set(ns, s); }
    return s;
  }
  function gc(s) { if (!s.agent && !s.viewers.size) sessions.delete(s.ns); } // 다 나가면 프레임까지 사라진다

  const okViewers = (s) => [...s.viewers.values()].filter((v) => v.ok);
  const notifyAgent = (s) => push(s.agent?.res, { type: 'viewers', count: okViewers(s).length }); // 인증된 사람만 센다
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
      s.agent.res?.end(); s.agent = null; s.frame = null;
      // 에이전트가 다시 시작되면 PIN 이 바뀌었을 수 있다 → 모두 다시 인증
      for (const v of s.viewers.values()) { clearTimeout(v.pendingTimer); v.pendingTimer = null; v.ok = false; }
      notifyAll(s, { type: 'agent', online: false });
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
        s.viewers.set(token, { res: null, vid: crypto.randomBytes(6).toString('hex'), ok: false, fails: 0, pendingTimer: null });
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

    // ── 실시간 알림 ────────────────────────────────
    if (p === '/api/remote/agent/events' && req.method === 'GET') {
      const a = auth(url, 'agent');
      if (!a || a.s?.agent?.token !== a.token) { send(res, 401, '다시 연결해야 해요'); return true; }
      clearTimeout(a.t.timer);
      a.s.agent.res = res;
      sse(req, res, () => dropToken(a.token));
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
      if (v.ok && a.s.frame) push(res, { type: 'frame', seq: a.s.frame.seq, w: a.s.frame.w, h: a.s.frame.h });
      notifyAgent(a.s);
      return true;
    }

    // ── 화면 ───────────────────────────────────────
    if (p === '/api/remote/frame' && req.method === 'POST') {
      const a = auth(url, 'agent');
      if (!a || a.s?.agent?.token !== a.token) { send(res, 401, '다시 연결해야 해요'); return true; }
      body(FRAME_MAX, (buf) => {
        if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, 'JPEG 가 아니에요');
        const w = Math.min(8192, Number(url.searchParams.get('w')) || 0), h = Math.min(8192, Number(url.searchParams.get('h')) || 0);
        const s = a.s;
        if (!okViewers(s).length) return send(res, 200, 'idle'); // 인증된 보는 사람이 없으면 받지 않는다
        s.frame = { buf, seq: ++s.seq, w, h, at: Date.now() };   // 최신 한 장만 — 이전 프레임은 버려진다
        notifyOk(s, { type: 'frame', seq: s.frame.seq, w, h });
        send(res, 200, 'ok');
      });
      return true;
    }
    if (p === '/api/remote/frame' && req.method === 'GET') {
      const a = auth(url, 'viewer');
      if (!a || !a.s?.viewers.has(a.token)) { send(res, 401, '다시 연결해야 해요'); return true; }
      if (!a.s.viewers.get(a.token).ok) { send(res, 403, 'PIN 을 먼저 확인해야 해요'); return true; } // 인증 전에는 화면을 주지 않는다
      const f = a.s.frame;
      if (!f) { send(res, 404, '아직 화면이 없어요'); return true; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': f.buf.length, 'Cache-Control': 'no-store', 'X-Frame-Seq': f.seq });
      res.end(f.buf);
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
