// 기록은 남기지 않는다. 방 입장권(token)은 이 탭에만, 기기 이름·마지막 방 이름만 이 기기에 기억한다.
const $ = (id) => document.getElementById(id);
const safe = (s) => ({
  get(k) { try { return s().getItem(k); } catch { return null; } },
  set(k, v) { try { s().setItem(k, v); } catch {} },
  del(k) { try { s().removeItem(k); } catch {} },
});
const local = safe(() => localStorage);
const tab = safe(() => sessionStorage);

// 서버 없이 화면만 보는 모드: /#demo, 또는 window.TT_DEMO = 'chat' | 'alone' | 'entry'
const DEMO = location.hash === '#demo' ? 'chat' : window.TT_DEMO;

let session = null; // { token, id, room }
try { session = JSON.parse(tab.get('tt.session')); } catch {}
let mode = 'join';
let others = 0;
let peers = null; // 직전 접속 목록 (id -> name). null 이면 아직 첫 수신 전
let unread = 0;
let es;

const api = (path, extra = {}) => `/api/${path}?${new URLSearchParams({ token: session?.token || '', ...extra })}`;
const me = () => session?.id;

/* ── 입장 ─────────────────────────────── */
function setMode(m) {
  mode = m;
  $('tabJoin').setAttribute('aria-selected', m === 'join');
  $('tabCreate').setAttribute('aria-selected', m === 'create');
  $('entryBtn').textContent = m === 'join' ? '들어가기' : '방 만들고 들어가기';
  $('pwInput').placeholder = m === 'join' ? '방 비밀번호' : '4자 이상 정해 주세요';
  $('entryErr').textContent = '';
}

function showEntry(err = '') {
  es?.close();
  $('chat').hidden = true; $('entry').hidden = false;
  $('entryErr').textContent = err;
  $('nameInput').value ||= local.get('tt.name') || guessName();
  $('roomInput').value ||= local.get('tt.room') || '';
  $('pwInput').value = '';
  ($('roomInput').value ? $('pwInput') : $('roomInput')).focus({ preventScroll: true });
}

async function submitEntry(e) {
  e.preventDefault();
  const room = $('roomInput').value.trim();
  const password = $('pwInput').value;
  const name = $('nameInput').value.trim() || guessName();
  if (!room) return ($('entryErr').textContent = '방 이름을 입력하세요');
  if (password.length < 4) return ($('entryErr').textContent = mode === 'create' ? '비밀번호는 4자 이상으로 정해 주세요' : '비밀번호를 입력하세요');
  local.set('tt.name', name); local.set('tt.room', room);
  if (DEMO) return startDemo('chat', room);

  $('entryBtn').disabled = true;
  const r = await fetch('/api/join', { method: 'POST', body: JSON.stringify({ room, password, name, create: mode === 'create' }) }).catch(() => null);
  $('entryBtn').disabled = false;
  if (!r) return ($('entryErr').textContent = '서버에 연결할 수 없어요');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    $('entryErr').textContent = j.error || '들어가지 못했어요';
    if (r.status === 404) setTimeout(() => { setMode('create'); $('entryErr').textContent = '그런 방이 없어서 새로 만들 수 있어요'; }, 0);
    return;
  }
  session = j;
  tab.set('tt.session', JSON.stringify(session));
  enterChat();
}

function guessName() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return '태블릿';
  if (/Android|iPhone|Mobile/i.test(ua)) return '휴대폰';
  return 'PC';
}

/* ── 대화방 ───────────────────────────── */
function enterChat() {
  $('entry').hidden = true; $('chat').hidden = false;
  $('roomName').textContent = session.room;
  $('emptyRoom').textContent = session.room;
  peers = null;
  connect();
  sendShared();
  $('text').focus({ preventScroll: true });
}

function connect() {
  es?.close();
  es = new EventSource(api('events'));
  es.onerror = async () => {
    setStatus('off');
    // 방이 사라졌으면 재접속하지 않고 입장 화면으로
    const r = await fetch(api('ping')).catch(() => null);
    if (r?.status === 401) roomGone('방이 사라졌어요. 다시 만들거나 들어와 주세요');
  };
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'presence') onPresence(m.users);
    else add(m);
  };
}

function roomGone(msg) {
  es?.close();
  session = null; tab.del('tt.session');
  clearList();
  showEntry(msg);
}

function onPresence(users) {
  const now = new Map(users.filter((u) => u.id !== me()).map((u) => [u.id, u.name]));
  if (peers) {
    for (const [id, n] of now) if (!peers.has(id)) sys(`${n} 님이 들어왔어요`);
    for (const [id, n] of peers) if (!now.has(id)) sys(`${n} 님이 나갔어요`);
  }
  peers = now;
  others = now.size;
  setStatus(others ? 'on' : 'alone', [...now.values()]);
}

function setStatus(state, names = []) {
  $('dot').className = `dot ${state}`;
  $('status').textContent =
    state === 'on' ? `${names.join(', ')} · ${names.length + 1}명` :
    state === 'alone' ? '나만 있어요' : '다시 연결하는 중…';
  $('emptyAlone').hidden = state === 'on';
  $('emptyReady').hidden = state !== 'on';
}

/* ── 메시지 그리기 ─────────────────────── */
const fmtTime = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const fmtSize = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = `<path d="${d}"/>`; return s; };
const ICON_FILE = 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5';
const ICON_DOWN = 'M12 4v12M6 11l6 6 6-6M5 20h14';

// 같은 사람이 같은 분에 연달아 보내면 이름·시간을 한 번만 보여주는 카톡식 묶음
function row(m) {
  const mine = m.from === me();
  const li = el('li', `row ${mine ? 'mine' : 'theirs'}`);
  li.dataset.group = `${m.from}|${Math.floor(m.at / 60000)}`;
  const prev = $('list').lastElementChild;
  if (prev?.dataset.group === li.dataset.group) {
    li.classList.add('cont');
    prev.classList.add('has-next');
    prev.querySelector('time')?.remove();
  }
  if (!mine) li.append(el('div', 'name', m.name));
  const line = el('div', 'line');
  li.append(line);
  return { li, line };
}

function place(li) {
  const sc = $('scroller');
  const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  $('list').append(li);
  sc.classList.add('has-msgs');
  if (atBottom || li.classList.contains('mine')) sc.scrollTop = sc.scrollHeight;
}

function clearList() { $('list').innerHTML = ''; $('scroller').classList.remove('has-msgs'); }

function linkify(node, text) {
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    node.append(text.slice(last, m.index));
    const a = el('a', null, m[0]); a.href = m[0]; a.target = '_blank'; a.rel = 'noopener';
    node.append(a);
    last = m.index + m[0].length;
  }
  node.append(text.slice(last));
}

function saveLink(src, fname, cls) {
  const a = el('a', cls); a.href = src; a.download = fname; a.title = '저장'; a.setAttribute('aria-label', `${fname} 저장`);
  a.append(svg(ICON_DOWN));
  return a;
}

function add(m) {
  const { li, line } = row(m);
  let bubble;

  if (m.type === 'msg') {
    bubble = el('div', 'bubble text');
    linkify(bubble, m.text);
    bubble.title = '눌러서 복사';
    bubble.onclick = (e) => {
      if (e.target.closest('a') || getSelection().toString()) return;
      copy(m.text, '복사했어요');
    };
  } else {
    const src = m.src || api(`file/${m.fid}`);
    const isImg = m.mime.startsWith('image/');
    const isVid = m.mime.startsWith('video/');
    if (isImg || isVid) {
      bubble = el('div', 'bubble media');
      if (isImg) {
        const img = new Image(); img.src = src; img.alt = m.fname; img.loading = 'lazy';
        img.onclick = () => window.open(src, '_blank');
        bubble.append(img);
      } else {
        const v = el('video'); v.src = src; v.controls = true; v.playsInline = true; v.preload = 'metadata';
        bubble.append(v);
      }
      bubble.append(saveLink(src, m.fname, 'save-chip'));
    } else {
      bubble = el('div', 'bubble doc');
      const ic = el('div', 'doc-icon'); ic.append(svg(ICON_FILE));
      const meta = el('div', 'doc-meta');
      meta.append(el('b', null, m.fname), el('small', null, `${fmtSize(m.size)} · 10분 뒤 만료`));
      bubble.append(ic, meta, saveLink(src, m.fname, 'save'));
    }
  }

  line.append(bubble, el('time', null, fmtTime(m.at)));
  place(li);
  if (m.from !== me() && document.hidden) { unread++; document.title = `(${unread}) Text Tunnel`; }
}

function sys(text) { place(el('li', 'sys', text)); }

/* ── 보내기 ───────────────────────────── */
async function sendText(e) {
  e.preventDefault();
  const text = $('text').value;
  if (!text.trim()) return;
  $('text').value = ''; syncInput();
  if (DEMO) return add({ type: 'msg', from: me(), text, at: Date.now() });
  const r = await fetch(api('send'), { method: 'POST', body: JSON.stringify({ text }) }).catch(() => null);
  if (!r?.ok) { $('text').value = text; syncInput(); return toast('보내지 못했어요'); }
  if (!others) toast('방에 나만 있어서 아무도 받지 못했어요');
}

function upload(file) {
  if (DEMO) return add({ type: 'file', from: me(), fname: file.name, mime: file.type, size: file.size, at: Date.now(), src: URL.createObjectURL(file) });
  const li = el('li', 'row mine');
  const line = el('div', 'line');
  const b = el('div', 'bubble pending');
  const label = el('div', null, `${file.name} 보내는 중…`);
  const bar = el('div', 'bar'); const fill = el('i'); bar.append(fill);
  b.append(label, bar); line.append(b); li.append(line);
  place(li);

  const fail = (msg) => { b.classList.add('failed'); label.textContent = `${file.name} · ${msg}`; bar.remove(); };
  if (!file.size) return fail('빈 파일은 보낼 수 없어요');

  // 8MB씩 나눠 순서대로 보낸다. 서버가 다 모이면 방 사람들에게 알린다.
  const CHUNK = 8 * 1024 * 1024;
  const uid = crypto.randomUUID?.() || String(Math.random()).slice(2);
  const sendChunk = (offset) => {
    const part = file.slice(offset, offset + CHUNK);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api('upload', { uid, offset, total: file.size, name: file.name }));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { fill.style.width = `${((offset + e.loaded) / file.size) * 100}%`; };
    xhr.onload = () => {
      if (xhr.status !== 200) return fail(xhr.responseText || '실패');
      if (xhr.responseText === 'done') li.remove();
      else sendChunk(offset + part.size);
    };
    xhr.onerror = () => fail('연결이 끊겼어요');
    xhr.send(part);
  };
  sendChunk(0);
}

/* ── 초대 · 나가기 ─────────────────────── */
async function invite() {
  const link = `${location.origin}/#r/${encodeURIComponent(session.room)}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { return await navigator.share({ title: 'Text Tunnel', text: `"${session.room}" 방으로 들어와요`, url: link }); } catch { return; }
  }
  copy(link, '초대 링크를 복사했어요. 비밀번호는 따로 알려 주세요');
}

function askLeave() {
  $('sheetSub').textContent = others ? '나가도 방은 남아 있어요' : '나만 있어서 나가면 방과 대화가 사라져요';
  $('sheet').hidden = false;
  $('sheetCancel').focus();
}

async function leave() {
  $('sheet').hidden = true;
  if (!DEMO) await fetch(api('leave'), { method: 'POST' }).catch(() => {});
  roomGone('');
}

/* ── 작은 도구들 ───────────────────────── */
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = el('textarea'); t.value = text; document.body.append(t); t.select();
    document.execCommand('copy'); t.remove();
  }
  toast(msg);
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

function syncInput() {
  const t = $('text');
  t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px';
  $('sendBtn').disabled = !t.value.trim();
}

// 안드로이드 공유 메뉴로 들어온 것: 서비스워커가 캐시에 넣어 두고 /?shared=1 로 연다
async function sendShared() {
  if (DEMO || !new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', '/');
  const cache = await caches.open('tt-share').catch(() => null);
  if (!cache) return;
  for (const req of await cache.keys()) {
    const r = await cache.match(req);
    if (req.url.endsWith('/shared/text')) {
      const text = await r.text();
      if (text.trim()) await fetch(api('send'), { method: 'POST', body: JSON.stringify({ text }) }).catch(() => {});
    } else {
      const blob = await r.blob();
      upload(new File([blob], decodeURIComponent(r.headers.get('x-name') || 'file'), { type: blob.type }));
    }
    await cache.delete(req);
  }
}

/* ── 이벤트 연결 ───────────────────────── */
$('entry').onsubmit = submitEntry;
$('tabJoin').onclick = () => setMode('join');
$('tabCreate').onclick = () => setMode('create');
$('composer').onsubmit = sendText;
$('text').oninput = syncInput;
// PC에서는 Enter 전송, Shift+Enter 줄바꿈. 휴대폰은 키보드 Enter가 줄바꿈.
$('text').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault(); $('composer').requestSubmit();
  }
};
// 캡처 이미지를 Ctrl+V 하면 바로 보낸다
$('text').onpaste = (e) => {
  const fs = [...(e.clipboardData?.files || [])];
  if (fs.length) { e.preventDefault(); fs.forEach(upload); }
};
$('file').onchange = (e) => { [...e.target.files].forEach(upload); e.target.value = ''; };
$('invite').onclick = invite;
$('emptyInvite').onclick = invite;
$('leave').onclick = askLeave;
$('sheetOk').onclick = leave;
$('sheetCancel').onclick = () => { $('sheet').hidden = true; };
$('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('sheet').hidden = true; });

// 파일을 창에 끌어다 놓으면 보낸다 (PC)
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
$('chat').addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('drop').hidden = false; } });
$('chat').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
$('chat').addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
$('chat').addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  [...e.dataTransfer.files].forEach(upload);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  unread = 0; document.title = 'Text Tunnel';
  if (!DEMO && session && es?.readyState === 2) connect();
});

if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});

/* ── 데모 ─────────────────────────────── */
function startDemo(scene, room = '우리집') {
  session = { token: 'demo', id: 'me', room };
  if (scene === 'entry') { session = null; $('roomInput').value = '우리집'; return showEntry(); }
  $('entry').hidden = true; $('chat').hidden = false;
  $('roomName').textContent = room; $('emptyRoom').textContent = room;
  onPresence([{ id: 'me', name: 'PC' }]);
  if (scene === 'alone') return;
  onPresence([{ id: 'me', name: 'PC' }, { id: 'p', name: '휴대폰' }]);
  const t = Date.now() - 5 * 60000;
  const img = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#ffb36b"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs><rect width="640" height="420" fill="url(#g)"/><circle cx="470" cy="130" r="56" fill="#fff" opacity=".85"/><path d="M0 330l160-120 140 100 120-70 220 150v30H0z" fill="#2b2250" opacity=".55"/></svg>');
  [
    { type: 'msg', from: 'p', name: '휴대폰', text: '이 링크 PC에서 열어줘', at: t },
    { type: 'msg', from: 'p', name: '휴대폰', text: 'https://www.example.com/docs/getting-started', at: t + 1000 },
    { type: 'msg', from: 'me', text: '받았어 👍', at: t + 60000 },
    { type: 'file', from: 'p', name: '휴대폰', fname: 'IMG_2041.jpg', mime: 'image/svg+xml', size: 2_340_000, at: t + 120000, src: img },
    { type: 'file', from: 'me', fname: '견적서_v2.pdf', mime: 'application/pdf', size: 482_000, at: t + 180000, src: '#' },
    { type: 'msg', from: 'me', text: '이거 확인하고 회신 부탁해.\n오늘 6시 전까지!', at: t + 181000 },
  ].forEach(add);
}

/* ── 시작 ─────────────────────────────── */
(async () => {
  if (DEMO) return startDemo(DEMO);
  const inv = /^#r\/(.+)$/.exec(location.hash);
  if (inv) {
    $('roomInput').value = decodeURIComponent(inv[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (session?.token) {
    const r = await fetch(api('ping')).catch(() => null);
    if (r?.ok) return enterChat();
    session = null; tab.del('tt.session');
  }
  setMode('join');
  showEntry();
})();
