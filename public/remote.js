// 원격조종 보는 화면 (이슈 #17 화면 보기, #21 PIN, #23 마우스·키보드 조종). 메신저(app.js)와 분리된 모듈 — app.js 의 전역(key, show, SCREENS 등)만 빌려 쓴다.
//
// 흐름: 메신저에 저장된 짝 열쇠로 /api/remote/view/join → SSE 로 "에이전트 온라인/새 프레임 번호" 수신
//       → 새 프레임 알림이 오면 /api/remote/frame 으로 최신 한 장을 가져와 캔버스에 그린다.
// 밀리면 버리기: 한 장을 가져오는 중에 알림이 여러 개 와도 끝난 뒤 "최신 것" 한 번만 다시 가져온다.
(() => {
  const $r = (id) => document.getElementById(id);
  const R = { token: null, es: null, fetching: false, again: false, online: false, authed: false, platform: 'pc', pin: null, ctlAllowed: false, ctl: false, q: [], sending: false, flushT: 0, keys: new Map(), held: new Set(), lastPos: null, w: 0, h: 0, seq: 0, stats: [] };
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
        R.online = m.online; R.name = m.name; R.platform = m.platform || 'pc'; // 폰 에이전트(#46)면 'android'
        if (!m.online) { R.authed = false; setControlState(false, false); $r('pinForm').hidden = true; $r('remoteEmpty').hidden = false; clearCanvas(); setStatus('원격 PC 의 에이전트가 꺼져 있어요', 'alone'); return; }
        $r('remoteEmpty').hidden = true;
        if (R.authed) { setStatus(`${m.name || '노트북'} 화면을 받는 중…`, 'on'); return; }
        // 에이전트가 (다시) 켜졌다 — PIN 이 바뀌었을 수 있어 다시 인증해야 한다. 방금 쓴 PIN 이 있으면 한 번만 자동으로 다시 넣는다
        if (R.pin) { const p = R.pin; R.pin = null; submitPin(p); } else askPin();
      } else if (m.type === 'stats') {
        showInfo(m);
      } else if (m.type === 'control') {
        setControlState(m.allowed, m.on);
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
      R.authed = true; R.pin = R.tryPin; updateCtlButton(); if ($r('remoteProfile').value !== 'auto') sendProfile(); // 기본값(자동)이면 보내지 않음 — 다른 보는 사람이 고른 프로필을 덮어쓰지 않게 // 연결이 끊겼다 돌아올 때 자동으로 다시 넣기 위해
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

  // ── 화질·속도 (이슈 #25) ───────────────────────────────
  // 프로필(자동/화질 우선/속도 우선)은 원격 PC 의 에이전트가 허용 범위 안에서 따른다. 아래 줄에는 에이전트가 알려 준 현재 상태가 보인다
  const PROFILE_LABEL = { auto: '자동', quality: '화질 우선', speed: '속도 우선' };
  function sendProfile() {
    if (!R.token) return;
    fetch(`/api/remote/view/profile?token=${encodeURIComponent(R.token)}`, { method: 'POST', body: JSON.stringify({ mode: $r('remoteProfile').value }) }).catch(() => {});
  }
  function showInfo(m) {
    $r('remoteInfo').textContent = `${PROFILE_LABEL[m.mode] || m.mode} · 화질 ${m.q} · 전송 ${m.ms}ms · 간격 ${m.interval}ms · PNG ${m.png} / JPEG ${m.jpg} 조각 · ${m.w}px`;
  }

  // ── 조종 (이슈 #23) ─────────────────────────────────────
  // 캔버스 위의 마우스·키보드를 작은 묶음으로 모아 /view/input 으로 보낸다. 좌표는 화면 비율(0~1).
  // 순서가 중요하므로 한 번에 하나씩만 보내고, 보내는 동안 쌓인 마우스 이동은 마지막 것 하나로 합친다.
  const VK = { Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: [13, 1], ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: [0xA3, 1], AltLeft: 0xA4, AltRight: [0xA5, 1],
    Pause: 19, CapsLock: 20, Lang1: 0x15, Lang2: 0x19, Escape: 27, Space: 32, PageUp: [33, 1], PageDown: [34, 1], End: [35, 1], Home: [36, 1], ArrowLeft: [37, 1], ArrowUp: [38, 1], ArrowRight: [39, 1], ArrowDown: [40, 1],
    PrintScreen: 44, Insert: [45, 1], Delete: [46, 1], MetaLeft: [91, 1], MetaRight: [92, 1], ContextMenu: [93, 1], NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: [111, 1],
    NumLock: 144, ScrollLock: 145, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222 };
  function vkOf(code) {
    let v = VK[code];
    if (v === undefined) {
      let m;
      if ((m = /^Key([A-Z])$/.exec(code))) v = m[1].charCodeAt(0);
      else if ((m = /^Digit([0-9])$/.exec(code))) v = 48 + Number(m[1]);
      else if ((m = /^Numpad([0-9])$/.exec(code))) v = 96 + Number(m[1]);
      else if ((m = /^F([0-9]{1,2})$/.exec(code)) && Number(m[1]) >= 1 && Number(m[1]) <= 12) v = 111 + Number(m[1]);
    }
    return v === undefined ? null : (Array.isArray(v) ? { vk: v[0], e: v[1] } : { vk: v, e: 0 });
  }
  // 캔버스에서 실제로 그림이 보이는 영역(object-fit: contain 의 여백 제외) 기준 비율 좌표
  function ratio(ev) {
    const c = $r('remoteCanvas'), b = c.getBoundingClientRect();
    const s = Math.min(b.width / c.width, b.height / c.height) || 1;
    const dw = c.width * s, dh = c.height * s, ox = b.left + (b.width - dw) / 2, oy = b.top + (b.height - dh) / 2;
    return { x: Math.min(1, Math.max(0, (ev.clientX - ox) / dw)), y: Math.min(1, Math.max(0, (ev.clientY - oy) / dh)) };
  }
  function queue(e) {
    if (!R.ctl) return;
    const last = R.q[R.q.length - 1];
    if (e.t === 'm' && last && last.t === 'm') R.q[R.q.length - 1] = e; // 이동은 마지막 것만
    else R.q.push(e);
    if (R.q.length > 400) { // 넘치면 이동·누름만 버린다 (떼기는 버리면 원격 PC 에서 눌린 채 남는다)
      const keep = R.q.filter((x) => x.t === 'u' || x.t === 'r' || (x.t === 'k' && !x.d));
      const rest = R.q.filter((x) => !(x.t === 'u' || x.t === 'r' || (x.t === 'k' && !x.d))).slice(-200);
      R.q = [...keep, ...rest];
    }
    if (!R.flushT) R.flushT = setTimeout(flush, 16);
  }
  async function flush() {
    R.flushT = 0;
    if (R.sending || !R.q.length || !R.token) return;
    R.sending = true;
    const ev = R.q.splice(0, 100);
    try {
      const r = await fetch(`/api/remote/view/input?token=${encodeURIComponent(R.token)}`, { method: 'POST', body: JSON.stringify({ ev }), signal: AbortSignal.timeout(4000) });
      if (r.status === 409 || r.status === 403) setControlState(R.ctlAllowed, false); // 조종이 꺼졌다
    } catch { R.q.unshift(...ev.filter((x) => x.t === 'u' || x.t === 'r' || (x.t === 'k' && !x.d))); /* 전송 실패: 떼기만 다시 시도 */ } finally { R.sending = false; if (R.q.length && !R.flushT) R.flushT = setTimeout(flush, 0); }
  }
  function setControlState(allowed, on) {
    R.ctlAllowed = !!allowed;
    const was = R.ctl; R.ctl = !!(allowed && on);
    if (was && !R.ctl) { R.q = []; R.keys.clear(); R.held.clear(); }
    $r('remoteScreen').querySelector('.remote-stage').classList.toggle('ctl', R.ctl);
    updateCtlButton();
    if (R.ctl && !was) $r('remoteCanvas').focus({ preventScroll: true });
  }
  function updateCtlButton() {
    const b = $r('remoteCtl');
    $r('remoteProfile').hidden = !R.authed;
    b.hidden = !R.authed;
    $r('remotePhoneBar').hidden = !(R.authed && R.ctl && R.platform === 'android'); // 폰 도구줄 (이슈 #46)
    b.disabled = !R.ctlAllowed;
    b.classList.toggle('on', R.ctl);
    b.textContent = R.ctl ? '조종 끄기' : (R.ctlAllowed ? '조종 켜기' : '조종 불가');
    b.title = R.ctlAllowed ? '' : '원격 PC 에서 조종이 허용되어 있지 않아요 (트레이 메뉴 → 원격 조종 허용)';
  }
  async function toggleControl() {
    const r = await fetch(`/api/remote/view/control?token=${encodeURIComponent(R.token)}`, { method: 'POST', body: JSON.stringify({ on: !R.ctl }) }).catch(() => null);
    if (!r || !r.ok) { const j = await r?.json().catch(() => null); setStatus(j?.error || '조종을 켜지 못했어요', 'alone'); return; }
    // 판정은 SSE('control') 로도 오지만 응답으로 먼저 반영
    const j = await r.json();
    if (!j.on) releaseAll(); // 끄기 전에 눌린 것 떼기 (에이전트도 조종이 꺼지면 스스로 뗀다)
    setControlState(j.allowed, j.on);
  }
  function releaseAll() { if (!R.token) return; R.keys.clear(); R.held.clear(); R.q = []; fetch(`/api/remote/view/input?token=${encodeURIComponent(R.token)}`, { method: 'POST', body: JSON.stringify({ ev: [{ t: 'r' }] }) }).catch(() => {}); }
  function wireInput() {
    const c = $r('remoteCanvas');
    c.addEventListener('mousemove', (e) => { if (R.ctl) { const p = ratio(e); R.lastPos = p; queue({ t: 'm', x: p.x, y: p.y }); } });
    c.addEventListener('mousedown', (e) => { if (!R.ctl) return; e.preventDefault(); c.focus({ preventScroll: true }); const p = ratio(e); R.held.add(e.button); queue({ t: 'd', x: p.x, y: p.y, b: e.button }); });
    // 버튼을 누른 채 캔버스 밖으로 나가 떼는 경우에도 원격 버튼이 풀리도록 window 에서 받는다
    window.addEventListener('mouseup', (e) => { if (!R.held.has(e.button)) return; R.held.delete(e.button); const p = ratio(e); queue({ t: 'u', x: p.x, y: p.y, b: e.button }); });
    c.addEventListener('contextmenu', (e) => { if (R.ctl) e.preventDefault(); });
    c.addEventListener('wheel', (e) => { if (!R.ctl) return; e.preventDefault(); queue({ t: 'w', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }); }, { passive: false });
    c.addEventListener('keydown', (e) => {
      if (!R.ctl) return; const k = vkOf(e.code); if (!k) return;
      e.preventDefault(); R.keys.set(k.vk, k.e);
      const ch = e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey ? e.key : undefined; // 폰은 키 코드가 아니라 입력된 글자가 필요하다 (PC 에이전트는 무시)
      queue(ch ? { t: 'k', vk: k.vk, d: 1, e: k.e, ch } : { t: 'k', vk: k.vk, d: 1, e: k.e });
    });
    c.addEventListener('keyup', (e) => {
      if (!R.ctl) return; const k = vkOf(e.code); if (!k) return;
      e.preventDefault(); R.keys.delete(k.vk); queue({ t: 'k', vk: k.vk, d: 0, e: k.e });
    });
    c.addEventListener('blur', () => { // 포커스를 잃으면 눌린 키·버튼을 모두 뗀다
      if (!R.ctl) return;
      for (const [vk, ext] of R.keys) queue({ t: 'k', vk, d: 0, e: ext });
      for (const b of R.held) { const p = R.lastPos || { x: 0.5, y: 0.5 }; queue({ t: 'u', x: p.x, y: p.y, b }); }
      R.keys.clear(); R.held.clear();
    }); // 포커스를 잃으면 눌린 키를 모두 뗀다
    $r('remoteCtl').onclick = toggleControl;
    for (const b of $r('remotePhoneBar').querySelectorAll('[data-nav]')) b.onclick = () => queue({ t: 'n', a: b.dataset.nav }); // 폰 뒤로·홈·최근·알림
    $r('phoneTextForm').onsubmit = (e) => { e.preventDefault(); const v = $r('phoneText').value; if (v) { queue({ t: 's', s: v }); $r('phoneText').value = ''; } }; // 한글 등 글자를 통째로
    $r('remoteProfile').onchange = sendProfile;
  }

  // 바뀐 부분 가져오기 (이슈 #24): "내가 마지막으로 그린 번호(since)" 이후의 조각들을 한 번에 받아 캔버스에 순서대로 덧그린다.
  // 처음이거나 많이 뒤처졌으면 서버가 전체 화면(키 프레임)부터 준다. 가져오는 중에 새 알림이 오면 끝난 뒤 한 번만 더 (중간은 한 묶음으로 따라잡음)
  // 묶음 형식: 'TTF1' | u32 번호 | u16 가로 | u16 세로 | u16 개수 | 개수 × { u16 x, y, w, h, u32 길이, 이미지 }
  async function pull() {
    if (R.fetching) { R.again = true; return; }
    R.fetching = true;
    try {
      do {
        R.again = false;
        const t0 = performance.now();
        const r = await fetch(`/api/remote/frame?token=${encodeURIComponent(R.token)}&since=${R.seq}`, { cache: 'no-store' });
        if (r.status === 204 || !r.ok) break;
        const buf = await r.arrayBuffer();
        const dv = new DataView(buf);
        if (buf.byteLength < 14 || dv.getUint32(0) !== 0x54544631) break; // 'TTF1'
        const seq = dv.getUint32(4), W = dv.getUint16(8), H = dv.getUint16(10), n = dv.getUint16(12);
        if (seq <= R.seq) continue; // 이미 그린 것
        const parts = []; let o = 14;
        for (let k = 0; k < n; k++) {
          const x = dv.getUint16(o), y = dv.getUint16(o + 2), w = dv.getUint16(o + 4), h = dv.getUint16(o + 6), len = dv.getUint32(o + 8); o += 12;
          parts.push({ x, y, w, h, blob: new Blob([new Uint8Array(buf, o, len)]) }); o += len;
        }
        const settled = await Promise.allSettled(parts.map((p) => createImageBitmap(p.blob))); // 디코딩은 한꺼번에, 그리기는 순서대로
        const bmps = settled.map((x) => (x.status === 'fulfilled' ? x.value : null));
        if (bmps.some((b) => !b)) { bmps.forEach((b) => b?.close?.()); R.seq = 0; break; } // 하나라도 못 풀었으면 버리고 다음에 전체 화면부터 다시 받는다
        const c = $r('remoteCanvas');
        if (c.width !== W || c.height !== H) {
          if (!(parts[0].x === 0 && parts[0].y === 0 && parts[0].w === W && parts[0].h === H)) { bmps.forEach((b) => b.close?.()); R.seq = 0; break; } // 크기가 바뀌었는데 전체 화면이 아니면 전체 화면부터 다시
          c.width = W; c.height = H;
        }
        const g = c.getContext('2d');
        bmps.forEach((b, k) => { g.drawImage(b, parts[k].x, parts[k].y); b.close?.(); });
        R.seq = seq;
        $r('remoteEmpty').hidden = true;
        stat(buf.byteLength, performance.now() - t0, n);
      } while (R.again);
    } catch {} finally { R.fetching = false; }
  }

  // 속도를 눈으로 보기: 최근 2초의 초당 갱신 횟수, 한 번에 받은 평균 크기, 가져오는 데 걸린 시간, 조각 수 (전체 화면이면 1개)
  function stat(bytes, ms, rects) {
    const now = performance.now();
    R.stats.push({ at: now, bytes, ms, rects });
    while (R.stats.length && now - R.stats[0].at > 2000) R.stats.shift();
    const n = R.stats.length;
    const fps = n / 2;
    const kb = R.stats.reduce((a, x) => a + x.bytes, 0) / n / 1024;
    const lat = R.stats.reduce((a, x) => a + x.ms, 0) / n;
    const total = R.stats.reduce((a, x) => a + x.bytes, 0) / 2 / 1024;
    $r('remoteStats').textContent = `초당 ${fps.toFixed(1)}번 갱신 · 한 번 평균 ${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB · 받는 데 ${Math.round(lat)}ms · ${Math.round(total)}KB/s · 조각 ${R.stats[n - 1].rects}개`;
  }

  function clearCanvas() { $r('remoteInfo').textContent = ''; const c = $r('remoteCanvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height); $r('remoteStats').textContent = ''; }

  function close() {
    R.es?.close(); R.es = null;
    if (R.token) { navigator.sendBeacon?.(`/api/remote/leave?token=${encodeURIComponent(R.token)}`); R.token = null; }
    R.again = false; R.stats = []; R.authed = false;
  }
  function back() { releaseAll(); setControlState(false, false); close(); R.pin = null; $r('pinForm').hidden = true; $r('pinInput').value = ''; clearCanvas(); enterChat(); }

  // ── 이 PC 원격 허용 켜기 안내 (이슈 #30) ───────────────────────
  // 에이전트가 켜져 있는지 실시간으로 보여 주고(보는 사람으로 입장해 'agent' 알림만 받음), 연결 코드를 만들어 실행 명령으로 보여 준다
  const Hs = { es: null, token: null, timer: 0 };
  const hostStatus = (text, state) => { $r('hostStatus').textContent = text; $r('hostDot').className = `dot ${state}`; };
  function hostClose() {
    Hs.es?.close(); Hs.es = null;
    if (Hs.token) { navigator.sendBeacon?.(`/api/remote/leave?token=${encodeURIComponent(Hs.token)}`); Hs.token = null; }
    clearInterval(Hs.timer); Hs.timer = 0;
  }
  async function openHost() {
    closeSheets(); show('hostScreen');
    $r('hostCodeBox').hidden = true;
    hostClose();
    if (!key) { hostStatus('먼저 메신저로 연결해야 해요', 'off'); return; }
    hostStatus('확인하는 중…', 'alone');
    const r = await fetch('/api/remote/view/join', { method: 'POST', body: JSON.stringify({ key }) }).catch(() => null);
    if (!r?.ok) { hostStatus('서버에 연결하지 못했어요', 'off'); return; }
    Hs.token = (await r.json()).token;
    Hs.es = new EventSource(`/api/remote/view/events?token=${encodeURIComponent(Hs.token)}`);
    Hs.es.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type !== 'agent') return;
      if (m.online) hostStatus(`에이전트가 켜져 있어요 (${m.name || 'PC'}) — 다른 PC 에서 원격 화면 보기로 들어갈 수 있어요`, 'on');
      else hostStatus('에이전트가 꺼져 있어요 — 아래 순서로 켜 보세요', 'alone');
    };
    Hs.es.onerror = () => hostStatus('다시 연결하는 중…', 'off');
  }
  async function makeCode() {
    if (!key) return;
    const b = $r('hostCodeBtn'); b.disabled = true;
    const r = await fetch('/api/pair/start', { method: 'POST', body: JSON.stringify({ key }) }).catch(() => null);
    b.disabled = false;
    if (!r?.ok) { $r('hostTimer').textContent = '코드를 받지 못했어요. 잠시 뒤 다시 해 주세요'; $r('hostCodeBox').hidden = false; return; }
    const j = await r.json();
    $r('hostCmd').textContent = `.\\run-agent.cmd --code ${j.code}`;
    $r('hostCodeBox').hidden = false; b.textContent = '새 코드 만들기';
    const end = Date.now() + j.expiresIn * 1000;
    clearInterval(Hs.timer);
    const tick = () => {
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      $r('hostTimer').textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 안에 실행하세요 (한 번만 쓸 수 있어요)` : '코드가 만료됐어요 — 새 코드를 만들어 주세요';
      if (!left) clearInterval(Hs.timer);
    };
    tick(); Hs.timer = setInterval(tick, 1000);
  }
  async function copyCmd() {
    const text = $r('hostCmd').textContent; if (!text) return;
    try { await navigator.clipboard.writeText(text); $r('hostCopy').textContent = '복사됨'; setTimeout(() => ($r('hostCopy').textContent = '복사'), 1500); }
    catch { const sel = getSelection(), rg = document.createRange(); rg.selectNodeContents($r('hostCmd')); sel.removeAllRanges(); sel.addRange(rg); $r('hostCopy').textContent = '선택됨 — Ctrl+C'; }
  }
  SCREENS.push('hostScreen');
  $r('mHost').onclick = openHost;
  $r('mHost').hidden = IS_MOBILE; // 조종당하는 쪽은 PC
  $r('hostBack').onclick = () => { hostClose(); enterChat(); };
  $r('hostCodeBtn').onclick = makeCode;
  $r('hostCopy').onclick = copyCmd;
  addEventListener('pagehide', hostClose);

  $r('mRemote').onclick = openRemote;
  $r('mRemote').hidden = IS_MOBILE; // 1단계는 PC 에서 보는 용도
  $r('remoteBack').onclick = back;
  wireInput();
  $r('pinForm').onsubmit = (e) => { e.preventDefault(); const p = $r('pinInput').value.trim(); if (p) submitPin(p); };
  addEventListener('pagehide', close);
})();
