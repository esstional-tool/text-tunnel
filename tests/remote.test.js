// 원격조종 서버 시험 (이슈 #17, #21): REMOTE_AUTH_TIMEOUT_SEC=2 node server.js 로 띄운 뒤
//   node tests/remote.test.js http://localhost:8787
// 가짜 에이전트가 PIN 을 확인하는 역할을 한다. 인증, PIN 통과 전 차단, 프레임 흐름, "최신 한 장만", 틀린 횟수 제한, 정리를 확인한다.
// (서버를 REMOTE_AUTH_TIMEOUT_SEC=2 없이 띄우면 "에이전트 무응답" 항목이 8초 걸린다)
const crypto = require('crypto');
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// HTTP 상태 코드는 응답 JSON 의 status 필드(예: 'checking')와 이름이 겹치므로 맨 뒤에 둔다
const post = (p, body) => fetch(`${B}/api/remote/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));
const PIN = '482915';

// 1x1 JPEG (유효한 최소 파일) 에 구별용 꼬리표를 붙여 프레임마다 다르게 만든다
const BASE = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const jpeg = (tag) => Buffer.concat([BASE, Buffer.from(tag)]);

function listen(path, token, onEvent) {
  const events = []; const ac = new AbortController();
  fetch(`${B}/api/remote/${path}?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) { const e = JSON.parse(d); events.push(e); onEvent?.(e); } }
    }
  }).catch(() => {});
  return { events, close: () => ac.abort(), last: (t) => events.filter((e) => e.type === t).pop(), all: (t) => events.filter((e) => e.type === t) };
}
const sendFrame = (token, buf, w = 640, h = 360) => fetch(`${B}/api/remote/frame?token=${token}&w=${w}&h=${h}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: buf }).then(async (r) => ({ code: r.status, text: await r.text() }));
const getFrame = (token) => fetch(`${B}/api/remote/frame?token=${token}`).then(async (r) => ({ code: r.status, buf: Buffer.from(await r.arrayBuffer()), seq: r.headers.get('x-frame-seq') }));
const auth = (token, pin) => post(`view/auth?token=${token}`, { pin });

// 가짜 에이전트: 'auth' 요청이 오면 PIN 을 확인해 판정을 돌려준다 (mode 'silent' 면 답하지 않는다)
function agent(token, mode = 'pin') {
  const st = { fails: 0, asked: [] };
  const l = listen('agent/events', token, async (e) => {
    if (e.type !== 'auth') return;
    st.asked.push(e.pin);
    if (mode === 'silent') return;
    const right = e.pin === PIN;
    if (!right) st.fails++;
    await post(`agent/auth?token=${token}`, { vid: e.vid, ok: right, left: 5 - st.fails, code: right ? '' : 'wrong' });
  });
  return { ...l, st };
}

(async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  const otherKey = crypto.randomBytes(32).toString('base64url');

  ok((await post('agent/join', { key: 'short' })).status === 400, '이상한 열쇠로 에이전트 입장 → 400');
  ok((await post('view/join', {})).status === 400, '열쇠 없이 보기 입장 → 400');

  const ag = await post('agent/join', { key, name: '노트북' });
  ok(ag.status === 200 && ag.token, '에이전트 입장 (열쇠 = 입장 자격)');
  const la = agent(ag.token);
  await sleep(300);

  // 다른 열쇠를 가진 사람은 이 에이전트를 못 본다
  const stranger = await post('view/join', { key: otherKey });
  const lst = listen('view/events', stranger.token);
  await sleep(300);
  ok(lst.last('agent')?.online === false, '다른 열쇠로는 에이전트가 안 보임 (오프라인으로 표시)');
  lst.close();

  // ── 열쇠만으로는 화면을 못 본다 ──────────────────
  const v1 = await post('view/join', { key });
  ok(v1.status === 200 && v1.agentOnline === true && v1.needPin === true, '같은 열쇠로 입장 → 에이전트 온라인, PIN 이 필요하다고 알려 줌');
  const lv1 = listen('view/events', v1.token);
  await sleep(400);
  ok(lv1.last('agent')?.online === true && lv1.last('agent')?.name === '노트북', '입장한 쪽이 에이전트 이름·온라인을 받음');
  ok(la.last('viewers')?.count === 0, '인증 전에는 에이전트가 "보는 사람 0명" (화면을 찍지 않음)');
  ok((await getFrame(v1.token)).code === 403, '인증 전에는 화면을 줄 수 없음 (403)');
  ok((await sendFrame(ag.token, jpeg('X'))).text === 'idle', '인증된 사람이 없으면 프레임을 받지 않음 (idle)');
  ok(lv1.all('frame').length === 0, '인증 전에는 "새 프레임" 알림도 못 받음');

  // ── PIN ────────────────────────────────────────
  ok((await auth(v1.token, '12ab')).status === 400, 'PIN 형식이 아니면 거절 (6~12자리 숫자 아님 → 400)');
  ok((await auth(v1.token, '000000')).status === 200, '틀린 PIN 도 요청은 접수 (판정은 에이전트가)');
  await sleep(400);
  const wrong = lv1.last('auth');
  ok(wrong && wrong.ok === false && wrong.left === 4 && wrong.code === 'wrong', `틀리면 보는 쪽이 "남은 횟수 4" 를 받음 (${JSON.stringify(wrong)})`);
  ok((await getFrame(v1.token)).code === 403 && la.last('viewers')?.count === 0, '틀린 뒤에도 화면은 안 가고 에이전트는 0명');
  ok(la.st.asked[0] === '000000' && la.st.asked.length === 1, '에이전트가 보는 사람이 보낸 PIN 을 전달받아 직접 확인함');

  ok((await auth(v1.token, PIN)).status === 200, '맞는 PIN 입력');
  await sleep(400);
  ok(lv1.last('auth')?.ok === true, '에이전트가 맞다고 판정 → 보는 쪽이 인증됨');
  ok(la.last('viewers')?.count === 1, '인증되자 에이전트가 "보는 사람 1명" 알림을 받음 (이때부터 화면을 찍는다)');

  // ── 프레임 흐름 (인증된 뒤) ───────────────────────
  ok((await sendFrame(ag.token, Buffer.from('not a jpeg'))).code === 400, 'JPEG 가 아니면 거절 (400)');
  ok((await sendFrame(ag.token, Buffer.concat([BASE, Buffer.alloc(4.5 * 1024 * 1024)]))).code === 413, '4MB 넘는 프레임은 거절 (413)');
  ok((await sendFrame(v1.token, jpeg('x'))).code === 401, '보는 사람은 프레임을 올릴 수 없음 (401)');
  ok((await sendFrame(ag.token, jpeg('F1'), 1280, 720)).text === 'ok', '에이전트가 프레임 업로드');
  await sleep(300);
  const ev1 = lv1.last('frame');
  ok(ev1?.seq === 1 && ev1.w === 1280 && ev1.h === 720, `인증된 사람에게 "새 프레임" 알림 (seq ${ev1?.seq}, ${ev1?.w}x${ev1?.h})`);
  const g1 = await getFrame(v1.token);
  ok(g1.code === 200 && g1.buf.equals(jpeg('F1')) && g1.seq === '1', '가져온 프레임이 원본과 같음');

  // 최신 한 장만
  await sendFrame(ag.token, jpeg('F2')); await sendFrame(ag.token, jpeg('F3')); await sendFrame(ag.token, jpeg('F4'));
  await sleep(300);
  ok(lv1.all('frame').length === 4, '프레임 3장이 더 와서 알림 4개');
  const g4 = await getFrame(v1.token);
  ok(g4.buf.equals(jpeg('F4')) && g4.seq === '4', '느린 보는 쪽은 최신(F4)만 가져옴 — 중간 프레임은 서버에 남지 않음 (밀리면 버리기)');

  // 늦게 들어온 사람: 인증 전에는 아무것도 못 받고, 인증하면 현재 프레임 번호부터
  const v2 = await post('view/join', { key }); const lv2 = listen('view/events', v2.token);
  await sleep(400);
  ok(lv2.all('frame').length === 0 && (await getFrame(v2.token)).code === 403, '늦게 들어온 사람도 PIN 전에는 화면·알림이 없음 (이미 화면이 흐르는 중인데도)');
  await auth(v2.token, PIN); await sleep(400);
  ok(lv2.last('frame')?.seq === 4, '인증하면 현재 프레임 번호부터 받음');
  ok(la.last('viewers')?.count === 2, '에이전트가 "보는 사람 2명" 알림');

  // 인증 안 한 입장자는 세지도 않고 화면도 안 받는다
  const v3 = await post('view/join', { key }); const lv3 = listen('view/events', v3.token);
  await sleep(300);
  await sendFrame(ag.token, jpeg('F5')); await sleep(300);
  ok(lv3.all('frame').length === 0 && la.last('viewers')?.count === 2, '인증 안 한 세 번째 입장자는 화면을 못 받고 인원에도 안 셈');
  await fetch(`${B}/api/remote/leave?token=${v3.token}`, { method: 'POST' }); lv3.close();

  // 나가기
  await fetch(`${B}/api/remote/leave?token=${v2.token}`, { method: 'POST' }); await sleep(300);
  ok(la.last('viewers')?.count === 1, '한 명 나가면 에이전트가 1명으로 알림');
  lv1.close(); await sleep(400);
  ok(la.last('viewers')?.count === 0, '모두 나가면 에이전트가 0명 알림 (화면 찍기를 멈춘다)');
  ok((await sendFrame(ag.token, jpeg('F6'))).text === 'idle', '보는 사람이 없으면 프레임을 받지 않음 (idle)');

  // ── 에이전트가 꺼졌다 켜지면 모두 다시 인증 ─────────
  const v4 = await post('view/join', { key }); const lv4 = listen('view/events', v4.token);
  await sleep(300); await auth(v4.token, PIN); await sleep(400);
  ok(lv4.last('auth')?.ok === true, '(준비) 보는 사람 하나를 인증시킴');
  await sendFrame(ag.token, jpeg('G1')); await sleep(200);
  await fetch(`${B}/api/remote/leave?token=${ag.token}`, { method: 'POST' }); await sleep(300);
  ok(lv4.last('agent')?.online === false, '에이전트가 OFF 하면 보는 쪽이 오프라인으로 바뀜');
  ok((await getFrame(v4.token)).code === 403, 'OFF 후에는 마지막 화면이 남지 않고 인증도 풀림 (403)');
  ok((await sendFrame(ag.token, jpeg('G2'))).code === 401, 'OFF 한 에이전트의 옛 입장권은 무효 (401)');

  const ag2 = await post('agent/join', { key, name: '노트북' }); const la2 = agent(ag2.token);
  await sleep(500);
  ok(lv4.last('agent')?.online === true, '에이전트를 다시 켜면 기다리던 보는 쪽이 온라인으로');
  ok(la2.last('viewers')?.count === 0 && (await getFrame(v4.token)).code === 403, '새로 켠 에이전트는 이전에 인증된 사람도 0명으로 봄 (PIN 이 바뀌었을 수 있어 다시 인증해야 함)');
  await auth(v4.token, PIN); await sleep(400);
  ok(lv4.last('auth')?.ok === true && la2.last('viewers')?.count === 1, '다시 PIN 을 입력하면 인증됨');

  // 같은 열쇠로 에이전트가 또 들어오면(재시작) 이전 연결을 대체
  const ag3 = await post('agent/join', { key, name: '노트북' });
  ok((await sendFrame(ag2.token, jpeg('G3'))).code === 401 && ag3.status === 200, '에이전트가 새로 들어오면 이전 입장권은 무효 (한 열쇠에 에이전트 하나)');
  la.close(); la2.close(); lv4.close();
  await fetch(`${B}/api/remote/leave?token=${v4.token}`, { method: 'POST' });
  await fetch(`${B}/api/remote/leave?token=${ag3.token}`, { method: 'POST' });

  // ── 서버의 방어: 틀린 횟수 제한 (에이전트가 이상해도) ───
  const keyB = crypto.randomBytes(32).toString('base64url');
  const agB = await post('agent/join', { key: keyB, name: 'B' }); const lb = agent(agB.token);
  await sleep(300);
  const vA = await post('view/join', { key: keyB }); const lvA = listen('view/events', vA.token);
  await sleep(300);
  let lastCode;
  for (let i = 0; i < 5; i++) { lastCode = (await auth(vA.token, '111111')).status; await sleep(120); }
  ok(lastCode === 200 && lvA.all('auth').filter((e) => e.ok === false).length === 5, '한 사람이 5번 틀림 — 5번 모두 판정을 받음');
  const sixth = await auth(vA.token, PIN);
  ok(sixth.status === 429, `6번째부터는 맞는 PIN 이어도 서버가 막음 (429) — 응답 ${sixth.status}`);
  await sleep(300); // 잠김 알림(SSE)은 응답보다 약간 늦게 도착한다
  ok(lvA.last('auth')?.locked === true, `막힌 사람에게는 잠겼다는 알림도 감 (${JSON.stringify(lvA.last('auth'))})`);
  const vB = await post('view/join', { key: keyB }); const lvB = listen('view/events', vB.token);
  await sleep(300);
  for (let i = 0; i < 5; i++) { await auth(vB.token, '222222'); await sleep(120); }
  const vC = await post('view/join', { key: keyB });
  ok((await auth(vC.token, PIN)).status === 429, '같은 열쇠로 10분에 10번 틀리면, 새로 들어온 사람도 막힘 (429)');
  ok(lb.st.asked.length === 10, '에이전트에는 막히기 전의 10번만 전달됨 (막힌 뒤의 시도는 에이전트까지 가지 않음)');
  for (const t of [vA.token, vB.token, vC.token, agB.token]) await fetch(`${B}/api/remote/leave?token=${t}`, { method: 'POST' });
  lb.close(); lvA.close(); lvB.close();

  // ── 에이전트가 없거나 답하지 않을 때 ─────────────────
  const keyC = crypto.randomBytes(32).toString('base64url');
  const vN = await post('view/join', { key: keyC });
  ok((await auth(vN.token, PIN)).status === 409, '에이전트가 없으면 PIN 확인을 요청할 수 없음 (409)');
  const agC = await post('agent/join', { key: keyC, name: 'C' }); const lc = agent(agC.token, 'silent');
  await sleep(300);
  const vS = await post('view/join', { key: keyC }); const lvS = listen('view/events', vS.token);
  await sleep(300);
  const t0 = Date.now();
  ok((await auth(vS.token, PIN)).status === 200, '에이전트가 답하지 않는 상태에서 PIN 요청 접수');
  ok((await auth(vS.token, PIN)).status === 409, '확인하는 중에 또 요청하면 거절 (409)');
  for (let i = 0; i < 120 && !lvS.last('auth'); i++) await sleep(100);
  const timedOut = lvS.last('auth');
  ok(timedOut?.ok === false && /응답하지 않아요/.test(timedOut.error || ''), `에이전트가 답하지 않으면 시간이 지나 실패로 알림 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  ok((await getFrame(vS.token)).code === 403, '무응답이어도 인증은 되지 않음 (안전한 쪽으로 실패)');
  for (const t of [vN.token, vS.token, agC.token]) await fetch(`${B}/api/remote/leave?token=${t}`, { method: 'POST' });
  lc.close(); lvS.close();
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
