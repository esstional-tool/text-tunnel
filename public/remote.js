// 원격조종 보는 화면 (이슈 #17, 1단계: 화면 보기). 메신저(app.js)와 분리된 모듈 — app.js 의 전역(key, show, SCREENS 등)만 빌려 쓴다.
//
// 흐름: 메신저에 저장된 짝 열쇠로 /api/remote/view/join → SSE 로 "에이전트 온라인/새 프레임 번호" 수신
//       → 새 프레임 알림이 오면 /api/remote/frame 으로 최신 한 장을 가져와 캔버스에 그린다.
// 밀리면 버리기: 한 장을 가져오는 중에 알림이 여러 개 와도 끝난 뒤 "최신 것" 한 번만 다시 가져온다.
(() => {
  const $r = (id) => document.getElementById(id);
  const R = { token: null, es: null, fetching: false, again: false, online: false, w: 0, h: 0, seq: 0, stats: [] };
  SCREENS.push('remoteScreen'); // app.js 의 화면 전환(show)이 이 화면도 알게 한다

  const setStatus = (text, state) => { $r('remoteStatus').textContent = text; $r('remoteDot').className = `dot ${state}`; };

  async function openRemote() {
    closeSheets();
    show('remoteScreen');
    if (!key) { setStatus('먼저 메신저로 연결해야 해요', 'off'); return; }
    await connect();
  }

  async function connect() {
    close();
    setStatus('연결하는 중…', 'alone');
    const r = await fetch('/api/remote/view/join', { method: 'POST', body: JSON.stringify({ key }) }).catch(() => null);
    if (!r?.ok) { setStatus('서버에 연결하지 못했어요', 'off'); return; }
    const j = await r.json();
    R.token = j.token; R.seq = 0;
    R.es = new EventSource(`/api/remote/view/events?token=${encodeURIComponent(R.token)}`);
    R.es.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'agent') {
        R.online = m.online;
        setStatus(m.online ? `${m.name || '노트북'} 화면을 받는 중…` : '원격 PC 의 에이전트가 꺼져 있어요', m.online ? 'on' : 'alone');
        $r('remoteEmpty').hidden = m.online;
        if (!m.online) clearCanvas();
      } else if (m.type === 'frame') {
        R.w = m.w; R.h = m.h;
        pull(m.seq);
      }
    };
    R.es.onerror = async () => {
      setStatus('다시 연결하는 중…', 'off');
      const p = await fetch(`/api/remote/ping?token=${encodeURIComponent(R.token)}`).catch(() => null);
      if (p?.status === 401) { R.es.close(); setTimeout(() => !$r('remoteScreen').hidden && connect(), 800); } // 서버가 재시작돼 입장권이 사라진 경우
    };
  }

  // 최신 프레임 한 장 가져오기. 가져오는 중에 새 알림이 오면 끝난 뒤 한 번만 더 (중간 프레임은 버린다)
  async function pull() {
    if (R.fetching) { R.again = true; return; }
    R.fetching = true;
    try {
      do {
        R.again = false;
        const t0 = performance.now();
        const r = await fetch(`/api/remote/frame?token=${encodeURIComponent(R.token)}`, { cache: 'no-store' });
        if (!r.ok) break;
        const seq = Number(r.headers.get('x-frame-seq'));
        const blob = await r.blob();
        if (seq <= R.seq) continue; // 이미 그린 것
        const bmp = await createImageBitmap(blob);
        const c = $r('remoteCanvas');
        if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close?.();
        R.seq = seq;
        $r('remoteEmpty').hidden = true;
        stat(blob.size, performance.now() - t0);
      } while (R.again);
    } catch {} finally { R.fetching = false; }
  }

  // 속도를 눈으로 보기: 최근 2초의 초당 프레임, 프레임 크기, 가져오는 데 걸린 시간
  function stat(bytes, ms) {
    const now = performance.now();
    R.stats.push({ at: now, bytes, ms });
    while (R.stats.length && now - R.stats[0].at > 2000) R.stats.shift();
    const n = R.stats.length;
    const fps = n / 2;
    const kb = R.stats.reduce((s, x) => s + x.bytes, 0) / n / 1024;
    const lat = R.stats.reduce((s, x) => s + x.ms, 0) / n;
    $r('remoteStats').textContent = `초당 ${fps.toFixed(1)}장 · 한 장 ${Math.round(kb)}KB · 받는 데 ${Math.round(lat)}ms · ${Math.round(fps * kb)}KB/s`;
  }

  function clearCanvas() { const c = $r('remoteCanvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height); $r('remoteStats').textContent = ''; }

  function close() {
    R.es?.close(); R.es = null;
    if (R.token) { navigator.sendBeacon?.(`/api/remote/leave?token=${encodeURIComponent(R.token)}`); R.token = null; }
    R.again = false; R.stats = [];
  }
  function back() { close(); clearCanvas(); enterChat(); }

  $r('mRemote').onclick = openRemote;
  $r('mRemote').hidden = IS_MOBILE; // 1단계는 PC 에서 보는 용도
  $r('remoteBack').onclick = back;
  addEventListener('pagehide', close);
})();
