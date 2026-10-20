// 두 기기가 QR/코드로 한 번 짝을 맺으면 같은 열쇠를 각자 이 기기에 보관하고, 앱을 열 때마다 그 열쇠로 자동 연결한다.
// 대화는 어디에도 저장하지 않는다. 이 기기에 남는 것은 열쇠·기기 이름·기기 ID뿐이다.
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// 서버 없이 화면만 보는 모드: /#demo(=chat), /#demo-wait 처럼 장면 지정, 또는 window.TT_DEMO
// 장면: 'welcome' | 'code' | 'qr' | 'install-android' | 'install-ios' | 'wait' | 'chat'
const DEMO = /^#demo(?:-([\w-]+))?$/.test(location.hash) ? (location.hash.slice(6) || 'chat') : window.TT_DEMO;

const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|Mobile/i.test(UA);
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let key = store.get('tt.key');
let myName = store.get('tt.name') || guessName();
let device = store.get('tt.device');
if (!device) { device = crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now(); store.set('tt.device', device); }

let token = null;   // 이번 접속의 입장권
let myId = null;    // 이번 접속에서 내 메시지를 알아보는 ID
let others = 0;
let peers = null;   // 직전 접속 목록 (id -> name). null 이면 아직 첫 수신 전
let unread = 0;
let es;
let installPrompt = null;
let qrTimer;

const api = (path, extra = {}) => `/api/${path}?${new URLSearchParams({ token: token || '', ...extra })}`;
const post = (path, body) => fetch(`/api/${path}`, { method: 'POST', body: JSON.stringify(body) });

function guessName() {
  if (/iPad|Tablet/i.test(navigator.userAgent)) return '태블릿';
  if (/Android|iPhone|Mobile/i.test(navigator.userAgent)) return '휴대폰';
  return 'PC';
}

/* ── 화면 전환 ─────────────────────────── */
const SCREENS = ['boot', 'welcome', 'codeForm', 'qrScreen', 'install', 'chat', 'extScreen'];
function show(id) { for (const s of SCREENS) $(s).hidden = s !== id; }

/* ── 서버 깨우기 (무료 서버는 쉬면 잠든다) ─── */
async function wake() {
  const slow = setTimeout(() => show('boot'), 1200);
  for (;;) {
    const r = await fetch('/api/health', { cache: 'no-store' }).catch(() => null);
    if (r?.ok) break;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  clearTimeout(slow);
}

/* ── 짝 맺기 ──────────────────────────── */
async function openQr() {
  show('qrScreen');
  $('qrBox').innerHTML = ''; $('qrCode').textContent = '······'; $('qrTimer').textContent = ''; $('qrRenew').hidden = true;
  if (DEMO) return drawQr('K7M4QX', 300);
  const r = await post('pair/start', key ? { key } : {}).catch(() => null);
  if (!r?.ok) { $('qrTimer').textContent = '코드를 받지 못했어요. 잠시 뒤 다시 해 주세요'; $('qrRenew').hidden = false; return; }
  const j = await r.json();
  if (!key) { key = j.key; store.set('tt.key', key); }
  drawQr(j.code, j.expiresIn);
  if (!token) joinRoom(); // 미리 방에 들어가 있다가 상대가 오면 바로 대화 화면으로
}

const fmtCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;
function renderQr(box, code) {
  const qr = qrcode(0, 'M');
  qr.addData(`${location.origin}/#pair=${code}`); qr.make();
  box.innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
  box.querySelector('svg').setAttribute('aria-hidden', 'true');
}

// 상대를 기다리는 동안 대기 화면에 다시 연결용 QR을 띄워 둔다. 코드는 5분짜리라 끝나기 전에 새로 받는다
let waitTimer = null;
async function refreshWaitQr() {
  clearTimeout(waitTimer); waitTimer = null;
  if (DEMO) { renderQr($('waitQr'), 'K7M4QX'); $('waitCode').textContent = fmtCode('K7M4QX'); return; }
  if (others || !key || document.hidden || $('chat').hidden) return;
  const r = await post('pair/start', { key }).catch(() => null);
  if (!r?.ok || others) return;
  const j = await r.json();
  renderQr($('waitQr'), j.code);
  $('waitCode').textContent = fmtCode(j.code);
  waitTimer = setTimeout(refreshWaitQr, (j.expiresIn - 15) * 1000);
}

function drawQr(code, seconds) {
  renderQr($('qrBox'), code);
  $('qrCode').textContent = fmtCode(code);
  const end = Date.now() + seconds * 1000;
  clearInterval(qrTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    $('qrTimer').textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 동안 쓸 수 있어요` : '시간이 지났어요';
    if (!left) { clearInterval(qrTimer); $('qrBox').style.opacity = .25; $('qrRenew').hidden = false; }
  };
  $('qrBox').style.opacity = 1;
  tick(); qrTimer = setInterval(tick, 1000);
}

function closeQr() {
  clearInterval(qrTimer);
  if (key) enterChat(); else show('welcome');
}

async function claim(code) {
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return ($('codeErr').textContent = '6자리를 입력하세요');
  $('codeBtn').disabled = true; $('codeErr').textContent = '';
  const r = await post('pair/claim', { code }).catch(() => null);
  $('codeBtn').disabled = false;
  if (!r) return ($('codeErr').textContent = '서버에 연결할 수 없어요');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { show('codeForm'); $('codeErr').textContent = j.error || '연결하지 못했어요'; return; }
  key = j.key; store.set('tt.key', key);
  joinRoom();
  if (IS_MOBILE && !STANDALONE) showInstall(); else enterChat();
}

function showInstall() {
  show('install');
  $('installIos').hidden = !IS_IOS;
  $('installAndroid').hidden = IS_IOS;
  $('installBtn').hidden = !installPrompt;
  $('installManual').hidden = !!installPrompt;
}

async function runInstall() {
  if (!installPrompt) return showInstall();
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice.catch(() => ({}));
  installPrompt = null;
  if (outcome === 'accepted') toast('설치했어요. 홈 화면의 아이콘으로 열 수 있어요');
  enterChat();
}

/* ── 연결 ─────────────────────────────── */
let joining = false;
async function joinRoom() {
  if (joining || !key) return;
  joining = true;
  const r = await post('join', { key, name: myName, device }).catch(() => null);
  joining = false;
  if (!r) { setStatus('off'); return setTimeout(joinRoom, 3000); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 꽉 찬 경우: 남아 있던 유령 자리는 서버가 90초 안에 비워 주므로 조금 뒤 다시 시도
    setStatus('full', r.status === 409 ? '이미 두 기기가 연결돼 있어요 · 잠시 뒤 다시 시도' : j.error);
    if (r.status === 409 || r.status === 429) setTimeout(joinRoom, 15000);
    return;
  }
  token = j.token; myId = j.id; peers = null;
  connect();
}

function connect() {
  es?.close();
  es = new EventSource(api('events'));
  es.onerror = async () => {
    setStatus('off');
    // 서버가 재시작됐거나 방이 정리됐으면 다시 들어간다
    const r = await fetch(api('ping')).catch(() => null);
    if (r?.status === 401) { es.close(); token = null; setTimeout(joinRoom, 500); }
  };
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'presence') onPresence(m.users);
    else if (m.type === 'clear') { clearList(); toast(m.from === myId ? '대화를 지웠어요' : `${m.name}에서 대화를 지웠어요`); }
    else add(m);
  };
}

function leaveNow() {
  if (!token || DEMO) return;
  navigator.sendBeacon?.(api('leave')) || fetch(api('leave'), { method: 'POST', keepalive: true }).catch(() => {});
  es?.close(); token = null;
}

function onPresence(users) {
  const now = new Map(users.filter((u) => u.id !== myId).map((u) => [u.id, u.name]));
  if (peers) {
    for (const [id, n] of now) if (!peers.has(id)) sys(`${n} 연결됨`);
    for (const [id, n] of peers) if (!now.has(id)) sys(`${n} 나감`);
  }
  const first = !peers?.size && now.size;
  peers = now;
  others = now.size;
  setStatus(others ? 'on' : 'alone', [...now.values()]);
  // QR 화면을 띄워 둔 채 상대가 들어오면 바로 대화로
  if (first && !$('qrScreen').hidden) { clearInterval(qrTimer); enterChat(); toast(`${[...now.values()][0]}와 연결됐어요`); }
}

function setStatus(state, info) {
  const names = Array.isArray(info) ? info : [];
  $('dot').className = `dot ${state === 'full' ? 'off' : state}`;
  $('peerTitle').textContent = state === 'on' ? names.join(', ') : 'Text Tunnel';
  $('status').textContent =
    state === 'on' ? '연결됨' :
    state === 'alone' ? '상대 기기를 기다리는 중' :
    state === 'full' ? (info || '연결할 수 없어요') : '다시 연결하는 중…';
  $('emptyWait').hidden = state === 'on';
  $('emptyReady').hidden = state !== 'on';
  if (state === 'alone' && !waitTimer) refreshWaitQr();
  if (state === 'on') { clearTimeout(waitTimer); waitTimer = null; }
}

function enterChat() {
  show('chat');
  if (!token && !DEMO) joinRoom();
  sendShared();
  if (!IS_MOBILE) $('text').focus({ preventScroll: true });
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
  const mine = m.from === myId;
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

// 사진은 앨범 말풍선에 담는다. 한 번에 고른 사진(같은 batch)은 같은 말풍선에 이어 붙인다
function addToAlbum(album, src, m) {
  const img = new Image(); img.src = src; img.alt = m.fname; img.loading = 'lazy';
  img.dataset.fname = m.fname;
  img.onclick = () => openViewer(img);
  const foot0 = album.querySelector('.album-foot');
  if (foot0) foot0.before(img); else album.append(img);
  const n = album.querySelectorAll('img').length;
  album.className = `bubble album ${n === 1 ? 'n1' : n === 2 ? 'n2' : n === 3 ? 'n3' : n === 4 ? 'n4' : 'nmany'}`;
  if (n >= 2) {
    let foot = album.querySelector('.album-foot');
    if (!foot) {
      foot = el('div', 'album-foot'); foot.append(el('span'), el('button', null, '모두 저장'));
      foot.querySelector('button').onclick = () => saveAll(album);
      album.append(foot);
    }
    foot.querySelector('span').textContent = `사진 ${n}장`;
  }
}

function saveAll(album) {
  for (const img of album.querySelectorAll('img')) {
    const a = el('a'); a.href = img.src; a.download = img.dataset.fname; document.body.append(a); a.click(); a.remove();
  }
}

function add(m) {
  if (m.type === 'file' && m.batch && m.mime.startsWith('image/')) {
    const album = [...$('list').querySelectorAll('.bubble.album')].find((b) => b.dataset.batch === m.batch);
    if (album) {
      const sc = $('scroller'); const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
      addToAlbum(album, m.src || api(`file/${m.fid}`), m);
      if (atBottom) sc.scrollTop = sc.scrollHeight;
      return;
    }
  }
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
    if (isImg) {
      bubble = el('div', 'bubble album n1');
      bubble.dataset.batch = m.batch || m.mid || String(Math.random());
      addToAlbum(bubble, src, m);
    } else if (isVid) {
      bubble = el('div', 'bubble media');
      const v = el('video'); v.src = src; v.controls = true; v.playsInline = true; v.preload = 'metadata';
      bubble.append(v, saveLink(src, m.fname, 'save-chip'));
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
  if (m.from !== myId && document.hidden) { unread++; document.title = `(${unread}) Text Tunnel`; }
}

function sys(text) { place(el('li', 'sys', text)); }

/* ── 보내기 ───────────────────────────── */
async function sendText(e) {
  e.preventDefault();
  sendTray(); // 미리보기에 골라 둔 사진·파일도 같이 보낸다
  const text = $('text').value;
  if (!text.trim()) return;
  $('text').value = ''; syncInput();
  if (DEMO) return add({ type: 'msg', from: myId, text, at: Date.now() });
  const r = await fetch(api('send'), { method: 'POST', body: JSON.stringify({ text }) }).catch(() => null);
  if (!r?.ok) { $('text').value = text; syncInput(); return toast('보내지 못했어요'); }
  if (!others) toast('상대 기기가 없어서 아무도 받지 못했어요');
}

const randId = () => crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now();
const kindOf = (f) => (f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'file');

// 카톡 '일반 화질'처럼 큰 사진은 긴 변 2048px JPEG로 줄인다. 줄일 수 없거나 더 커지면 원본 그대로
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

// 파일 하나를 8MB 조각으로 순서대로 올린다. 서버가 다 모이면 상대에게 알린다
function uploadOne(file, batch, onProgress) {
  const CHUNK = 8 * 1024 * 1024;
  const uid = randId();
  return new Promise((resolve, reject) => {
    const sendChunk = (offset) => {
      const part = file.slice(offset, offset + CHUNK);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', api('upload', { uid, offset, total: file.size, name: file.name, ...(batch ? { batch } : {}) }));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress(offset + e.loaded);
      xhr.onload = () => {
        if (xhr.status !== 200) return reject(new Error(xhr.responseText || '실패'));
        if (xhr.responseText === 'done') resolve(); else sendChunk(offset + part.size);
      };
      xhr.onerror = () => reject(new Error('연결이 끊겼어요'));
      xhr.send(part);
    };
    sendChunk(0);
  });
}

// 고른 파일들을 한 묶음으로 보낸다. 사진은 같은 batch로 올려 받는 쪽에서 앨범 하나로 묶이게 한다
async function sendFiles(files, original) {
  files = files.filter((f) => f.size > 0);
  if (!files.length) return;
  const batch = randId().replace(/[^\w-]/g, '').slice(0, 40);
  if (DEMO) {
    for (const f of files) add({ type: 'file', from: myId, fname: f.name, mime: f.type, size: f.size, batch, at: Date.now(), src: URL.createObjectURL(f) });
    return;
  }
  const imgs = files.filter((f) => kindOf(f) === 'image').length;
  const what = imgs === files.length ? `사진 ${imgs}장` : `${files.length}개`;
  const li = el('li', 'row mine');
  const line = el('div', 'line');
  const b = el('div', 'bubble pending');
  const label = el('div', null, `${what} 보내는 중…`);
  const bar = el('div', 'bar'); const fill = el('i'); bar.append(fill);
  b.append(label, bar); line.append(b); li.append(line);
  place(li);

  const prepared = [];
  for (const f of files) prepared.push(original || kindOf(f) !== 'image' ? f : await shrink(f));
  const total = prepared.reduce((s, f) => s + f.size, 0);
  let done = 0;
  const failed = [];
  for (const [i, f] of prepared.entries()) {
    if (files.length > 1) label.textContent = `${what} 보내는 중… ${i + 1}/${files.length}`;
    try {
      await uploadOne(f, kindOf(f) === 'image' ? batch : null, (sent) => { fill.style.width = `${((done + sent) / total) * 100}%`; });
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
    done += f.size;
  }
  if (!failed.length) return li.remove();
  b.classList.add('failed'); bar.remove();
  label.textContent = `${failed.length}개를 못 보냈어요 · ${failed.join(', ')}`;
}

/* ── 보내기 전 미리보기 (트레이) ─────────── */
let tray = []; // { file, url }
function addToTray(files) {
  const list = [...files];
  if (list.some((f) => !f.size)) toast('빈 파일은 뺐어요');
  for (const file of list.filter((f) => f.size)) {
    tray.push({ file, url: kindOf(file) === 'file' ? null : URL.createObjectURL(file) });
  }
  closeAttach();
  renderTray();
}

function renderTray() {
  $('tray').hidden = !tray.length;
  const list = $('trayList'); list.innerHTML = '';
  tray.forEach((t, i) => {
    const th = el('div', 'thumb');
    const k = kindOf(t.file);
    if (k === 'image') { const img = new Image(); img.src = t.url; img.alt = t.file.name; th.append(img); }
    else if (k === 'video') {
      const v = el('video'); v.src = t.url + '#t=0.1'; v.muted = true; v.preload = 'metadata'; v.playsInline = true;
      th.append(v, el('span', 'badge', '동영상'));
    } else {
      const d = el('div', 'doc-thumb'); d.append(svg(ICON_FILE), el('span', null, t.file.name)); th.append(d);
    }
    const x = el('button', 'remove'); x.type = 'button'; x.setAttribute('aria-label', `${t.file.name} 빼기`); x.append(svg('M6 6l12 12M18 6L6 18'));
    x.onclick = () => { if (t.url) URL.revokeObjectURL(t.url); tray.splice(i, 1); renderTray(); };
    th.append(x);
    list.append(th);
  });
  const imgs = tray.filter((t) => kindOf(t.file) === 'image').length;
  const vids = tray.filter((t) => kindOf(t.file) === 'video').length;
  const docs = tray.length - imgs - vids;
  $('originalWrap').hidden = !imgs;
  $('trayInfo').textContent = [imgs && `사진 ${imgs}`, vids && `동영상 ${vids}`, docs && `파일 ${docs}`].filter(Boolean).join(' · ')
    + ` · ${fmtSize(tray.reduce((s, t) => s + t.file.size, 0))}`;
  $('traySend').textContent = `${tray.length}개 보내기`;
  syncInput();
  list.scrollLeft = list.scrollWidth; // 방금 고른 것이 보이게 (scrollIntoView 는 바깥 페이지까지 움직여서 쓰지 않음)
}

function clearTray() {
  for (const t of tray) if (t.url) URL.revokeObjectURL(t.url);
  tray = []; renderTray();
}

function sendTray() {
  if (!tray.length) return;
  const files = tray.map((t) => t.file);
  const original = $('original').checked;
  clearTray();
  sendFiles(files, original);
}

/* ── 첨부 패널 ─────────────────────────── */
function toggleAttach(open = $('attachPanel').hidden) {
  $('attachPanel').hidden = !open;
  $('attachBtn').setAttribute('aria-expanded', open);
  if (open) $('text').blur();
}
const closeAttach = () => toggleAttach(false);

/* ── 사진 크게 보기 ─────────────────────── */
let viewerList = [], viewerIdx = 0;
function openViewer(img) {
  viewerList = [...$('list').querySelectorAll('.bubble.album img')];
  viewerIdx = Math.max(0, viewerList.indexOf(img));
  $('viewer').hidden = false;
  showViewer();
}
function showViewer() {
  const img = viewerList[viewerIdx];
  if (!img) return closeViewer();
  $('viewerImg').src = img.src; $('viewerImg').alt = img.alt;
  $('viewerSave').href = img.src; $('viewerSave').download = img.dataset.fname || 'photo';
  $('viewerCount').textContent = `${viewerIdx + 1} / ${viewerList.length}`;
  $('viewerPrev').hidden = viewerIdx === 0;
  $('viewerNext').hidden = viewerIdx === viewerList.length - 1;
}
const stepViewer = (d) => { const n = viewerIdx + d; if (n >= 0 && n < viewerList.length) { viewerIdx = n; showViewer(); } };
const closeViewer = () => { $('viewer').hidden = true; $('viewerImg').removeAttribute('src'); };

/* ── 대화 지우기 ───────────────────────── */
function clearList() {
  closeViewer();
  $('list').innerHTML = '';
  $('scroller').classList.remove('has-msgs');
}

async function clearChat() {
  closeSheets();
  if (DEMO) { clearList(); return toast('대화를 지웠어요'); }
  const r = await fetch(api('clear'), { method: 'POST' }).catch(() => null);
  if (!r?.ok) toast('지우지 못했어요. 연결을 확인해 주세요');
  // 화면은 서버가 보내는 'clear' 알림을 받아 양쪽에서 같이 비운다
}

function askConfirm(title, sub, okText, onOk) {
  $('menu').hidden = true;
  $('confirmTitle').textContent = title;
  $('confirmSub').textContent = sub;
  $('confirmOk').textContent = okText;
  $('confirmOk').onclick = onOk;
  $('confirm').hidden = false;
  $('confirmCancel').focus();
}

/* ── 메뉴 ─────────────────────────────── */
function openMenu() {
  $('menuName').textContent = `이 기기: ${myName}`;
  $('mInstall').hidden = STANDALONE || !(installPrompt || IS_MOBILE);
  $('menu').hidden = false;
}
const closeSheets = () => { $('menu').hidden = true; $('confirm').hidden = true; };

function rename() {
  closeSheets();
  const n = prompt('이 기기 이름', myName);
  if (!n?.trim()) return;
  myName = n.trim().slice(0, 20); store.set('tt.name', myName);
  if (DEMO) return;
  leaveNow(); joinRoom(); // 새 이름으로 다시 입장
  toast('이름을 바꿨어요');
}

function unpair() {
  closeSheets();
  leaveNow();
  key = null; store.del('tt.key');
  clearList(); clearTray(); closeAttach();
  show('welcome');
}

/* ── 방문 기록 지우기 (크롬 확장과 연결) ─── */
// 확장의 content.js 가 { source: 'tt-ext' } 메시지로 응답한다. 설치 전에 열린 페이지에는 붙지 않아 새로고침이 필요하다
let ext = null;
const toExt = (m) => window.postMessage({ source: 'tt-app', ...m }, location.origin);
addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'tt-ext') return;
  ext = e.data;
  if (e.data.type === 'cleaned') {
    $('extClean').disabled = false;
    $('extResult').textContent = e.data.error ? `지우지 못했어요: ${e.data.error}` : `방문 기록 ${e.data.count}개와 캐시를 지웠어요`;
  }
  renderExt();
});

function renderExt() {
  $('extOn').hidden = !ext;
  $('extOff').hidden = !!ext;
  if (ext) { $('extVer').textContent = `v${ext.version}`; $('extAuto').checked = ext.auto !== false; }
}

function openExt() {
  closeSheets();
  show('extScreen');
  $('extUrl').textContent = /Edg\//.test(navigator.userAgent) ? 'edge://extensions' : 'chrome://extensions';
  renderExt(); toExt({ type: 'ping' });
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
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

function syncInput() {
  const t = $('text');
  t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px';
  $('sendBtn').disabled = !t.value.trim() && !tray.length;
}

// 안드로이드 공유 메뉴로 들어온 것: 서비스워커가 캐시에 넣어 두고 /?shared=1 로 연다
async function sendShared() {
  if (DEMO || !new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', '/');
  while (!token) await new Promise((ok) => setTimeout(ok, 300));
  const cache = await caches.open('tt-share').catch(() => null);
  if (!cache) return;
  const files = [];
  for (const req of await cache.keys()) {
    const r = await cache.match(req);
    if (req.url.endsWith('/shared/text')) {
      const text = await r.text();
      if (text.trim()) await fetch(api('send'), { method: 'POST', body: JSON.stringify({ text }) }).catch(() => {});
    } else {
      const blob = await r.blob();
      files.push(new File([blob], decodeURIComponent(r.headers.get('x-name') || 'file'), { type: blob.type }));
    }
    await cache.delete(req);
  }
  sendFiles(files, false); // 공유 메뉴로 보낸 사진들도 앨범 하나로
}

/* ── 이벤트 연결 ───────────────────────── */
$('startPair').onclick = openQr;
$('showCode').onclick = () => { show('codeForm'); $('codeErr').textContent = ''; $('codeInput').focus(); };
$('codeBack').onclick = () => (key ? enterChat() : show('welcome'));
$('codeForm').onsubmit = (e) => { e.preventDefault(); if (DEMO) return showInstall(); claim($('codeInput').value); };
$('codeInput').oninput = (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  e.target.value = v.length > 3 ? `${v.slice(0, 3)} ${v.slice(3)}` : v;
};
$('qrClose').onclick = closeQr;
$('qrRenew').onclick = openQr;
$('installBtn').onclick = runInstall;
$('installSkip').onclick = enterChat;

$('composer').onsubmit = sendText;
$('text').oninput = syncInput;
// PC에서는 Enter 전송, Shift+Enter 줄바꿈. 휴대폰은 키보드 Enter가 줄바꿈.
$('text').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault(); $('composer').requestSubmit();
  }
};
// 캡처 이미지를 Ctrl+V 하면 미리보기에 올린다
$('text').onpaste = (e) => {
  const fs = [...(e.clipboardData?.files || [])];
  if (fs.length) { e.preventDefault(); addToTray(fs); }
};
$('text').onfocus = () => { if (IS_MOBILE) closeAttach(); };

// + 첨부 패널: 앨범(사진·동영상 선택 화면), 카메라(휴대폰), 파일
$('attachBtn').onclick = () => toggleAttach();
$('pickCameraBtn').hidden = !IS_MOBILE;
for (const [btn, input] of [['pickMediaBtn', 'pickMedia'], ['pickCameraBtn', 'pickCamera'], ['pickFileBtn', 'pickFile']]) {
  $(btn).onclick = () => $(input).click();
  $(input).onchange = (e) => { addToTray(e.target.files); e.target.value = ''; };
}
$('traySend').onclick = sendTray;
$('trayCancel').onclick = clearTray;

// 사진 크게 보기: 좌우 버튼·화살표 키·옆으로 밀기
$('viewerClose').onclick = closeViewer;
$('viewerPrev').onclick = () => stepViewer(-1);
$('viewerNext').onclick = () => stepViewer(1);
$('viewerImg').onclick = (e) => e.stopPropagation();
$('viewer').onclick = (e) => { if (e.target === $('viewer')) closeViewer(); };
let touchX = null;
$('viewer').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$('viewer').addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
});
document.addEventListener('keydown', (e) => {
  if ($('viewer').hidden) return;
  if (e.key === 'ArrowLeft') stepViewer(-1);
  if (e.key === 'ArrowRight') stepViewer(1);
  if (e.key === 'Escape') closeViewer();
});

$('menuBtn').onclick = openMenu;
$('mQr').onclick = () => { closeSheets(); openQr(); };
$('mInstall').onclick = () => { closeSheets(); installPrompt ? runInstall() : showInstall(); };
$('mRename').onclick = rename;
$('mExt').onclick = openExt;
$('mExt').hidden = IS_MOBILE;
$('extBack').onclick = () => (key ? enterChat() : show('welcome'));
$('extCopy').onclick = () => copy($('extUrl').textContent, '복사했어요. 새 탭 주소창에 붙여 넣으세요');
$('extReload').onclick = () => { try { sessionStorage.setItem('tt.openExt', '1'); } catch {} location.reload(); };
$('extClean').onclick = () => { $('extClean').disabled = true; $('extResult').textContent = '지우는 중…'; toExt({ type: 'clean' }); };
$('extAuto').onchange = (e) => toExt({ type: 'auto', on: e.target.checked });
$('mUnpair').onclick = () => askConfirm('연결을 해제할까요?', '이 기기에서 연결 정보가 지워져요. 다시 쓰려면 QR로 새로 연결해야 해요.', '연결 해제', unpair);
$('mClear').onclick = () => askConfirm('대화를 지울까요?', '양쪽 화면의 대화와 서버에 남은 사진·파일을 바로 지워요. 되돌릴 수 없어요.', '대화 지우기', clearChat);
$('mClose').onclick = closeSheets;
$('confirmCancel').onclick = closeSheets;
for (const s of ['menu', 'confirm']) $(s).onclick = (e) => { if (e.target === $(s)) closeSheets(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

// 파일을 창에 끌어다 놓으면 보낸다 (PC)
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
$('chat').addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('drop').hidden = false; } });
$('chat').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
$('chat').addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
$('chat').addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  addToTray(e.dataTransfer.files);
});

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); installPrompt = e;
  if (!$('install').hidden) showInstall();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  unread = 0; document.title = 'Text Tunnel';
  if (!others && key) refreshWaitQr();
  if (!DEMO && key && (!token || es?.readyState === 2)) { token = null; joinRoom(); }
});
// 창·앱을 닫으면 바로 나가서, 둘 다 닫으면 방이 즉시 사라지게 한다
addEventListener('pagehide', leaveNow);
addEventListener('pageshow', (e) => { if (e.persisted && key && !DEMO) { token = null; joinRoom(); } });

// 20초마다 살아 있다고 알린다. 서버는 이 신호가 끊긴 자리를 유령으로 보고, 방이 꽉 찼을 때 비워 준다
setInterval(async () => {
  if (DEMO || !token || document.hidden) return;
  const r = await fetch(api('ping')).catch(() => null);
  if (r?.status === 401) { es?.close(); token = null; joinRoom(); }
}, 20000);

$('mobileHint').hidden = !IS_MOBILE;

if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});

/* ── 데모 ─────────────────────────────── */
function startDemo(scene) {
  myId = 'me'; myName = 'PC';
  if (scene === 'welcome') return show('welcome');
  if (scene === 'ext') return openExt();
  if (scene === 'ext-on') { ext = { version: '1.0.0', auto: true }; return openExt(); }
  if (scene === 'code') { show('codeForm'); $('codeInput').value = 'K7M 4Q'; return; }
  if (scene === 'qr') return openQr();
  if (scene.startsWith('install')) {
    show('install');
    $('installIos').hidden = scene !== 'install-ios';
    $('installAndroid').hidden = scene === 'install-ios';
    $('installBtn').hidden = false; $('installManual').hidden = true;
    return;
  }
  show('chat');
  onPresence([{ id: 'me', name: 'PC' }]);
  if (scene === 'wait') return;
  onPresence([{ id: 'me', name: 'PC' }, { id: 'p', name: '휴대폰' }]);
  const t = Date.now() - 5 * 60000;
  // 예시 사진 (그라데이션 풍경)
  const pic = (a, b, w = 640, h = 420) => '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="72%" cy="30%" r="9%" fill="#fff" opacity=".85"/><path d="M0 ' + h * .78 + 'l' + w * .25 + '-' + h * .28 + ' ' + w * .22 + ' ' + h * .24 + ' ' + w * .19 + '-' + h * .17 + ' ' + w * .34 + ' ' + h * .36 + 'v' + h * .07 + 'H0z" fill="#2b2250" opacity=".5"/></svg>';
  const uri = (s) => 'data:image/svg+xml,' + encodeURIComponent(s);
  const shots = [['#ffb36b', '#7a5cff'], ['#5ee7df', '#3a7bd5'], ['#f9d976', '#f39f86']];
  [
    { type: 'msg', from: 'p', name: '휴대폰', text: '이 링크 PC에서 열어줘', at: t },
    { type: 'msg', from: 'p', name: '휴대폰', text: 'https://www.example.com/docs/getting-started', at: t + 1000 },
    { type: 'msg', from: 'me', text: '받았어 👍', at: t + 60000 },
    ...shots.map(([a, b], i) => ({ type: 'file', from: 'p', name: '휴대폰', fname: `IMG_204${i}.jpg`, mime: 'image/svg+xml', size: 1_800_000, batch: 'demo-album', at: t + 120000, src: uri(pic(a, b)) })),
    { type: 'file', from: 'me', fname: '견적서_v2.pdf', mime: 'application/pdf', size: 482_000, at: t + 180000, src: '#' },
    { type: 'msg', from: 'me', text: '이거 확인하고 회신 부탁해.\n오늘 6시 전까지!', at: t + 181000 },
  ].forEach(add);
  if (scene === 'attach') toggleAttach(true);
  if (scene === 'tray') {
    const f = (s, n) => new File([s], n, { type: 'image/svg+xml' });
    addToTray([f(pic('#a1c4fd', '#c2e9fb'), 'IMG_3001.jpg'), f(pic('#fbc2eb', '#a6c1ee'), 'IMG_3002.jpg'), f(pic('#84fab0', '#8fd3f4'), 'IMG_3003.jpg'), new File(['%PDF'], '회의록.pdf', { type: 'application/pdf' })]);
  }
  if (scene === 'viewer') openViewer($('list').querySelector('.bubble.album img'));
}

/* ── 시작 ─────────────────────────────── */
(async () => {
  if (DEMO) return startDemo(DEMO);
  const pairCode = /^#pair=([A-Za-z0-9]{6})$/.exec(location.hash)?.[1];
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  await wake();
  if (pairCode) { show('codeForm'); $('codeInput').value = `${pairCode.slice(0, 3)} ${pairCode.slice(3)}`; return claim(pairCode); }
  toExt({ type: 'ping' });
  let reopenExt = false;
  try { reopenExt = sessionStorage.getItem('tt.openExt') === '1'; sessionStorage.removeItem('tt.openExt'); } catch {}
  if (key) enterChat();
  if (reopenExt) return openExt();
  if (key) return;
  show('welcome');
})();
