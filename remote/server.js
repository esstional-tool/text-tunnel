// 원격조종 (이슈 #17) — 메신저와 분리된 모듈. 서버의 /api/remote/* 만 담당한다.
//
// 누가 누구와 연결되나
//   에이전트  = 조종당하는 PC 에서 도는 프로그램(agent/). 메신저의 "새 기기 연결" 코드로 같은 짝 열쇠를 받아 둔다
//   보는 사람 = 같은 열쇠를 가진 브라우저(메신저 앱). 열쇠 = 권한이라 "내 기기만"이 자동으로 지켜진다
//
// 기록 원칙: 화면 프레임은 **최신 한 장만 메모리에 덮어쓴다.** 디스크·로그에 아무것도 쓰지 않는다.
// 전송: 기존 SSE + POST 재사용 (의존성 0).
//   에이전트 → 서버   POST /api/remote/frame   (JPEG 한 장)
//   서버 → 보는 쪽    SSE 로 "새 프레임 번호"만 알림, 보는 쪽이 GET /api/remote/frame 으로 최신 한 장을 가져감
//                     → 보는 쪽이 느리면 알림이 쌓여도 최신 것만 가져온다 (밀리면 버리기)
//   서버 → 에이전트   SSE 로 "지금 보는 사람 수" — 0 이면 에이전트는 화면을 찍지도 않는다
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const FRAME_MAX = 4 * 1024 * 1024;
const TOKEN_GRACE = 30 * 1000; // SSE 를 안 연 입장권은 이 시간 뒤 버림

module.exports = function createRemote({ readBody, send, crypto }) {
  const sessions = new Map(); // 네임스페이스(열쇠 해시) -> { agent, viewers: Map, frame, seq }
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
    if (!s) { s = { ns, agent: null, viewers: new Map(), frame: null, seq: 0 }; sessions.set(ns, s); }
    return s;
  }
  function gc(s) { if (!s.agent && !s.viewers.size) sessions.delete(s.ns); } // 다 나가면 프레임까지 사라진다

  const notifyAgent = (s) => push(s.agent?.res, { type: 'viewers', count: s.viewers.size });
  const notifyViewers = (s, ev) => { for (const v of s.viewers.values()) push(v.res, ev); };

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
      notifyViewers(s, { type: 'agent', online: false });
    } else if (t.role === 'viewer' && s.viewers.has(token)) {
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
        s.viewers.set(token, { res: null });
        send(res, 200, { token, agentOnline: !!s.agent?.res });
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
      notifyViewers(a.s, { type: 'agent', online: true, name: a.s.agent.name });
      notifyAgent(a.s);
      return true;
    }
    if (p === '/api/remote/view/events' && req.method === 'GET') {
      const a = auth(url, 'viewer');
      if (!a || !a.s?.viewers.has(a.token)) { send(res, 401, '다시 연결해야 해요'); return true; }
      clearTimeout(a.t.timer);
      a.s.viewers.get(a.token).res = res;
      sse(req, res, () => dropToken(a.token));
      push(res, { type: 'agent', online: !!a.s.agent?.res, name: a.s.agent?.name });
      if (a.s.frame) push(res, { type: 'frame', seq: a.s.frame.seq, w: a.s.frame.w, h: a.s.frame.h });
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
        if (!s.viewers.size) return send(res, 200, 'idle'); // 보는 사람이 없으면 받지 않는다
        s.frame = { buf, seq: ++s.seq, w, h, at: Date.now() };   // 최신 한 장만 — 이전 프레임은 버려진다
        notifyViewers(s, { type: 'frame', seq: s.frame.seq, w, h });
        send(res, 200, 'ok');
      });
      return true;
    }
    if (p === '/api/remote/frame' && req.method === 'GET') {
      const a = auth(url, 'viewer');
      if (!a || !a.s?.viewers.has(a.token)) { send(res, 401, '다시 연결해야 해요'); return true; }
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
