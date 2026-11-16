// 큰 파일 PC 직접 저장 (이슈 #55). 메신저(app.js)와 분리된 모듈 — app.js 의 전역(myId, others, api, toast, place, el, canRead 등)을 빌려 쓴다.
// 보내는 쪽(휴대폰): 제안 → PC 가 "받기"할 때까지 기다림 → 8MB 조각을 순서대로 올림 (서버는 조각을 PC 로 바로 넘김).
// 받는 쪽(PC): "받기" → 저장 위치 선택 → 조각을 받는 대로 디스크에 씀. 저장 위치를 고를 수 없는 브라우저는 받을 수 없다.
const STREAM_CHUNK = 8 * 1024 * 1024;
const STREAM_RETRY = 5;
const streamCards = new Map(); // sid -> 말풍선 요소
const streamReason = {
  expired: '받는 쪽이 정해진 시간 안에 받지 않았어요',
  'receiver-gone': '받는 쪽 연결이 끊겨 중단했어요',
  stalled: '조각이 오래 멈춰서 중단했어요',
  cancelled: '보내는 쪽이 취소했어요',
  declined: '받는 쪽이 거절했어요',
};
const sGet = (sid) => fetch(api('stream/state', { sid })).then((r) => r.json()).catch(() => ({ state: 'unknown', received: 0 }));

/* ── 받는 쪽(PC) ───────────────────────── */
function onStream(m) {
  if (m.type === 'streamoffer') return m.from !== myId && showOffer(m);
  const b = streamCards.get(m.sid);
  if (!b) return;
  if (m.type === 'streamdone') return finishCard(b, `저장했어요 · ${m.name}`);
  if (m.type === 'streamfail') return finishCard(b, streamReason[m.reason] || '중단했어요', true);
  // streamready 는 보내는 쪽이 기다리는 신호라 받는 쪽 화면에서는 따로 보여 줄 게 없다
}

function showOffer(m) {
  const li = el('li', 'row theirs');
  const line = el('div', 'line');
  const b = el('div', 'bubble');
  b.append(el('div', null, `${m.fromName || '상대'}님이 파일을 보내려 해요`));
  const info = el('div', 'stream-info', `${m.name} · ${fmtSize(m.size)}`);
  const label = el('div', 'stream-state', '');
  const btns = el('div', 'stream-btns');
  const accept = el('button', 'stream-accept', '받기');
  const decline = el('button', 'stream-decline', '거절');
  accept.type = decline.type = 'button';
  accept.onclick = () => receiveFile(m, b);
  decline.onclick = () => cancelStream(m.sid);
  btns.append(accept, decline);
  b.append(info, label, btns);
  line.append(b); li.append(line);
  place(li);
  b.dataset.sid = m.sid;
  streamCards.set(m.sid, b);
}

function cardState(b, text, bad) {
  const s = b.querySelector('.stream-state');
  if (s) { s.textContent = text; s.classList.toggle('bad', !!bad); }
}
function finishCard(b, text, bad) {
  b.querySelector('.stream-btns')?.remove();
  cardState(b, text, bad);
  if (b.dataset.sid) streamCards.delete(b.dataset.sid);
}

async function cancelStream(sid) {
  await fetch(api('stream/cancel', { sid }), { method: 'POST' }).catch(() => {});
  const b = streamCards.get(sid);
  if (b) finishCard(b, '거절했어요');
}

async function receiveFile(m, b) {
  // 저장 위치 창은 "받기" 누른 순간에 바로 열어야 한다 (브라우저는 사용자 동작 안에서만 연다)
  if (!window.showSaveFilePicker) {
    toast('이 브라우저에서는 바로 저장할 수 없어요 · Edge·Chrome 데스크톱에서 받아 주세요');
    return;
  }
  let handle;
  try { handle = await showSaveFilePicker({ suggestedName: m.name }); }
  catch { return; } // 저장 창을 닫았으면 카드는 그대로 둔다
  b.querySelector('.stream-btns')?.remove();
  cardState(b, '받는 중…');
  let w;
  try { w = await handle.createWritable(); }
  catch { return finishCard(b, '저장 파일을 열 수 없어요', true); }
  const r = await fetch(api('stream/receive', { sid: m.sid })).catch(() => null);
  if (!r?.ok) { await w.abort?.().catch(() => {}); return finishCard(b, r?.status === 409 ? '이미 끝났거나 받을 수 없어요' : '연결하지 못했어요', true); }
  let got = 0;
  let last = 0;
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value);
      got += value.length;
      if (got - last > 16 * 1024 * 1024 || got === m.size) { last = got; cardState(b, `받는 중… ${Math.floor((got / m.size) * 100)}%`); }
    }
    if (got !== m.size) throw new Error('받다가 끊겼어요');
    await w.close();
    finishCard(b, `저장했어요 · ${m.name}`);
  } catch (e) {
    await w.abort?.().catch(() => {});
    finishCard(b, `${e.message || '받지 못했어요'} · 파일은 저장되지 않았어요`, true);
  }
}

/* ── 보내는 쪽(휴대폰) ─────────────────── */
// 조각 하나를 올린다 (XHR: 진행률을 보려고). 실패는 예외 없이 { status, text } 로 돌려준다 (0 = 끊김)
function postStreamChunk(sid, offset, part, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api('stream/chunk', { sid, offset }));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = 120000;
    xhr.upload.onprogress = (e) => onProgress(offset + e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = xhr.ontimeout = () => resolve({ status: 0, text: '' });
    xhr.send(part);
  });
}

// 파일 하나를 PC 에 바로 저장시킨다. 실패하면 이유를 담아 예외를 던진다
async function sendStream(file, onProgress, onStatus) {
  if (!others) throw new Error('PC 가 연결돼 있지 않아요 · PC 에서 앱을 열어 주세요');
  const off = await fetch(api('stream/offer'), { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size, mime: file.type }) })
    .then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }))
    .catch(() => ({ ok: false, status: 0, j: {} }));
  if (!off.ok) throw new Error(off.j.error || (off.status === 0 ? '서버에 연결할 수 없어요' : '보내지 못했어요'));
  const sid = off.j.sid;

  onStatus('PC 가 받을 준비를 기다리는 중… · PC 에서 "받기"를 눌러 주세요');
  for (let i = 0; ; i++) {
    if (i >= 600) throw new Error('PC 가 시간 안에 받지 않았어요');
    await new Promise((ok) => setTimeout(ok, 1000));
    const st = await sGet(sid);
    if (st.state === 'ready' || st.state === 'sending') break;
    if (st.state === 'gone' || st.state === 'failed') throw new Error('PC 가 받지 않았어요');
  }

  let offset = 0;
  let tries = 0;
  onStatus('PC 에 저장하는 중…');
  while (offset < file.size) {
    if (!(await canRead(file, offset))) throw new Error('파일을 읽을 수 없어요 · 다시 골라 주세요');
    const end = Math.min(offset + STREAM_CHUNK, file.size);
    const r = await postStreamChunk(sid, offset, file.slice(offset, end), onProgress);
    if (r.status === 200) {
      tries = 0;
      offset = end;
      if (r.text === 'done') return;
      continue;
    }
    if (r.status === 0 && tries < STREAM_RETRY) {
      // 연결이 끊겼다 → 서버가 받은 만큼을 물어보고 거기서 이어 보낸다 (응답만 끊긴 조각이 중복되지 않게)
      tries++;
      onStatus(`연결이 끊겨 다시 시도하는 중… (${tries}/${STREAM_RETRY})`);
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** (tries - 1)));
      const st = await sGet(sid);
      if (st.state === 'gone' || st.state === 'failed') throw new Error('PC 쪽 연결이 끊어졌어요');
      if (st.state !== 'unknown') offset = st.received;
      onStatus('PC 에 저장하는 중…');
      continue;
    }
    if (r.status === 410) throw new Error('PC 쪽 연결이 끊어졌어요');
    throw new Error((r.text && r.text.slice(0, 80)) || '보내다 멈췄어요');
  }
}

/* ── 이벤트 연결 ───────────────────────── */
// 보내기 트레이의 "PC에 바로 저장" 칸은 휴대폰에서만 보인다 (PC 는 받는 쪽)
