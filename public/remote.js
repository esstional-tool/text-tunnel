// 원격조종 보는 화면 (이슈 #17, 1단계: 화면 보기). 메신저(app.js)와 분리된 모듈 — app.js 의 전역(key, show, SCREENS 등)만 빌려 쓴다.
//
// 흐름: 메신저에 저장된 짝 열쇠로 /api/remote/view/join → SSE 로 "에이전트 온라인/새 프레임 번호" 수신
//       → 새 프레임 알림이 오면 /api/remote/frame 으로 최신 한 장을 가져와 캔버스에 그린다.
// 밀리면 버리기: 한 장을 가져오는 중에 알림이 여러 개 와도 끝난 뒤 "최신 것" 한 번만 다시 가져온다.
(() => {
  const $r = (id) => document.getElementById(id);
  const R = { token: null, es: null, fetching: false, again: false, online: false, authed: false, pin: null, w: 0, h: 0, seq: 0, stats: [] };
  // PIN 은 이 화면의 메모리에만 둔다 (저장 안 함, 새로고침·뒤로 가기에서 사라짐). 연결이 잠깐 끊겨 다시 들어갈 때 자동으로 다시 넣으려는 용도
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
        R.online = m.online; R.name = m.name;
        if (!m.online) { R.authed = false; $r('pinForm').hidden = true; $r('remoteEmpty').hidden = false; clearCanvas(); setStatus('원격 PC 의 에이전트가 꺼져 있어요', 'alone'); return; }
        $r('remoteEmpty').hidden = true;
        if (R.authed) { setStatus(`${m.name || '노트북'} 화면을 받는 중…`, 'on'); return; }
        // 에이전트가 (다시) 켜졌다 — PIN 이 바뀌었을 수 있어 다시 인증해야 한다. 방금 쓴 PIN 이 있으면 한 번만 자동으로 다시 넣는다
        if (R.pin) { const p = R.pin; R.pin = null; submitPin(p); } else askPin();
      } else if (m.type === 'auth') {
        onAuth(m);
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

  // ── PIN (이슈 #21): 맞는지는 원격 PC 의 에이전트가 직접 확인한다 ───────────────
  function askPin(msg) {
    $r('pinForm').hidden = false; $r('pinMsg').textContent = msg || '';
    $r('pinInput').disabled = false; $r('pinBtn').disabled = false;
    setStatus('접속 PIN 을 입력하세요', 'alone');
    $r('pinInput').focus({ preventScroll: true });
  }
  async function submitPin(pin) {
    $r('pinForm').hidden = false; $r('pinBtn').disabled = true; $r('pinInput').disabled = true; $r('pinMsg').textContent = '원격 PC 가 확인하는 중…';
    setStatus('PIN 확인하는 중…', 'alone');
    R.tryPin = pin;
    const r = await fetch(`/api/remote/view/auth?token=${encodeURIComponent(R.token)}`, { method: 'POST', body: JSON.stringify({ pin }) }).catch(() => null);
    if (!r) return askPin('서버에 연결하지 못했어요');
    if (r.status === 400) return askPin('PIN 은 6~12자리 숫자예요');
    if (r.status === 409) return askPin('원격 PC 가 꺼져 있거나 다른 확인이 진행 중이에요');
    if (r.status === 429) return askPin('너무 많이 틀려서 잠시 막혔어요. 나중에 다시 해 주세요');
    // 200 이면 판정이 SSE('auth')로 온다
  }
  function onAuth(m) {
    if (m.ok) {
      R.authed = true; R.pin = R.tryPin; // 연결이 끊겼다 돌아올 때 자동으로 다시 넣기 위해
      $r('pinForm').hidden = true; $r('pinInput').value = '';
      setStatus(`${R.name || '노트북'} 화면을 받는 중…`, 'on');
      return;
    }
    R.authed = false; R.pin = null; $r('pinInput').value = '';
    if (m.code === 'no-pin') return askPin('원격 PC 에서 먼저 접속 PIN 을 정해야 볼 수 있어요');
    if (m.locked) {
      const min = m.lockedUntil ? Math.max(1, Math.ceil((m.lockedUntil - Date.now()) / 60000)) : 0;
      return askPin(min ? `PIN 을 너무 많이 틀려서 잠겼어요. 약 ${min}분 뒤에 다시 해 주세요` : '너무 많이 틀려서 잠시 막혔어요');
    }
    if (m.code === 'wrong') return askPin(`PIN 이 맞지 않아요 (남은 횟수 ${m.left}번)`);
    askPin(m.error || '확인하지 못했어요');
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
    R.again = false; R.stats = []; R.authed = false;
  }
  function back() { close(); R.pin = null; $r('pinForm').hidden = true; $r('pinInput').value = ''; clearCanvas(); enterChat(); }

  $r('mRemote').onclick = openRemote;
  $r('mRemote').hidden = IS_MOBILE; // 1단계는 PC 에서 보는 용도
  $r('remoteBack').onclick = back;
  $r('pinForm').onsubmit = (e) => { e.preventDefault(); const p = $r('pinInput').value.trim(); if (p) submitPin(p); };
  addEventListener('pagehide', close);
})();
