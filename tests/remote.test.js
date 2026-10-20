// 원격조종 서버 시험 (이슈 #17): node tests/remote.test.js http://localhost:8787
// 가짜 에이전트·가짜 보는 사람으로 인증, 프레임 흐름, "최신 한 장만", 보는 사람 수 알림, 정리를 확인한다
const crypto = require('crypto');
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/remote/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

// 1x1 JPEG (유효한 최소 파일) 에 구별용 꼬리표를 붙여 프레임마다 다르게 만든다
const BASE = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const jpeg = (tag) => Buffer.concat([BASE, Buffer.from(tag)]);

function listen(path, token) {
  const events = []; const ac = new AbortController();
  fetch(`${B}/api/remote/${path}?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) events.push(JSON.parse(d)); }
    }
  }).catch(() => {});
  return { events, close: () => ac.abort(), last: (t) => events.filter((e) => e.type === t).pop() };
}
const sendFrame = (token, buf, w = 640, h = 360) => fetch(`${B}/api/remote/frame?token=${token}&w=${w}&h=${h}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: buf }).then(async (r) => ({ code: r.status, text: await r.text() }));
const getFrame = (token) => fetch(`${B}/api/remote/frame?token=${token}`).then(async (r) => ({ code: r.status, buf: Buffer.from(await r.arrayBuffer()), seq: r.headers.get('x-frame-seq') }));

(async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  const otherKey = crypto.randomBytes(32).toString('base64url');

  ok((await post('agent/join', { key: 'short' })).status === 400, '이상한 열쇠로 에이전트 입장 → 400');
  ok((await post('view/join', {})).status === 400, '열쇠 없이 보기 입장 → 400');

  const ag = await post('agent/join', { key, name: '노트북' });
  ok(ag.status === 200 && ag.token, '에이전트 입장 (열쇠 = 권한)');
  const la = listen('agent/events', ag.token);
  await sleep(300);

  // 다른 열쇠를 가진 사람은 이 에이전트를 못 본다
  const stranger = await post('view/join', { key: otherKey });
  const lst = listen('view/events', stranger.token);
  await sleep(300);
  ok(lst.last('agent')?.online === false, '다른 열쇠로는 에이전트가 안 보임 (오프라인으로 표시)');
  lst.close();

  const v1 = await post('view/join', { key });
  ok(v1.status === 200 && v1.agentOnline === true, '같은 열쇠로 보기 입장 → 에이전트 온라인');
  const lv1 = listen('view/events', v1.token);
  await sleep(400);
  ok(lv1.last('agent')?.online === true && lv1.last('agent')?.name === '노트북', '보는 쪽이 에이전트 이름·온라인을 받음');
  ok(la.last('viewers')?.count === 1, '에이전트가 "보는 사람 1명" 알림을 받음 (이때부터 화면을 찍는다)');

  // 프레임 흐름
  ok((await sendFrame(ag.token, Buffer.from('not a jpeg'))).code === 400, 'JPEG 가 아니면 거절 (400)');
  ok((await sendFrame(ag.token, Buffer.concat([BASE, Buffer.alloc(4.5 * 1024 * 1024)]))).code === 413, '4MB 넘는 프레임은 거절 (413)');
  ok((await sendFrame(v1.token, jpeg('x'))).code === 401, '보는 사람은 프레임을 올릴 수 없음 (401)');
  ok((await sendFrame(ag.token, jpeg('F1'), 1280, 720)).text === 'ok', '에이전트가 프레임 업로드');
  await sleep(300);
  const ev1 = lv1.last('frame');
  ok(ev1?.seq === 1 && ev1.w === 1280 && ev1.h === 720, `보는 쪽에 "새 프레임" 알림 (seq ${ev1?.seq}, ${ev1?.w}x${ev1?.h})`);
  const g1 = await getFrame(v1.token);
  ok(g1.code === 200 && g1.buf.equals(jpeg('F1')) && g1.seq === '1', '보는 쪽이 가져온 프레임이 원본과 같음');

  // 최신 한 장만: 알림이 쌓여도 가져가는 건 마지막 프레임
  await sendFrame(ag.token, jpeg('F2')); await sendFrame(ag.token, jpeg('F3')); await sendFrame(ag.token, jpeg('F4'));
  await sleep(300);
  ok(lv1.events.filter((e) => e.type === 'frame').length === 4, '프레임 3장이 더 와서 알림 4개');
  const g4 = await getFrame(v1.token);
  ok(g4.buf.equals(jpeg('F4')) && g4.seq === '4', '느린 보는 쪽은 최신(F4)만 가져옴 — 중간 프레임은 서버에 남지 않음 (밀리면 버리기)');

  // 늦게 들어온 보는 사람도 최신 프레임부터
  const v2 = await post('view/join', { key }); const lv2 = listen('view/events', v2.token);
  await sleep(400);
  ok(lv2.last('frame')?.seq === 4, '늦게 들어온 사람은 현재 프레임 번호부터 받음');
  ok(la.last('viewers')?.count === 2, '에이전트가 "보는 사람 2명" 알림');

  // 보는 사람이 나가면 에이전트에 알림, 다 나가면 프레임을 받지 않는다
  await fetch(`${B}/api/remote/leave?token=${v2.token}`, { method: 'POST' }); await sleep(300);
  ok(la.last('viewers')?.count === 1, '한 명 나가면 에이전트가 1명으로 알림');
  lv1.close(); await sleep(400);
  ok(la.last('viewers')?.count === 0, '모두 나가면 에이전트가 0명 알림 (화면 찍기를 멈춘다)');
  ok((await sendFrame(ag.token, jpeg('F5'))).text === 'idle', '보는 사람이 없으면 프레임을 받지 않음 (idle)');

  // 에이전트가 꺼지면 보는 쪽에 알림, 프레임도 사라진다
  const v3 = await post('view/join', { key }); const lv3 = listen('view/events', v3.token);
  await sleep(300);
  await fetch(`${B}/api/remote/leave?token=${ag.token}`, { method: 'POST' }); await sleep(300);
  ok(lv3.last('agent')?.online === false, '에이전트가 OFF 하면 보는 쪽이 오프라인으로 바뀜');
  ok((await getFrame(v3.token)).code === 404, 'OFF 후에는 마지막 화면도 남지 않음 (404)');
  ok((await sendFrame(ag.token, jpeg('F6'))).code === 401, 'OFF 한 에이전트의 옛 입장권은 무효 (401)');

  // 에이전트가 다시 켜지면 보는 쪽이 다시 온라인
  const ag2 = await post('agent/join', { key, name: '노트북' }); const la2 = listen('agent/events', ag2.token);
  await sleep(400);
  ok(lv3.last('agent')?.online === true && la2.last('viewers')?.count === 1, '에이전트를 다시 켜면 기다리던 보는 쪽이 온라인으로, 에이전트는 보는 사람 1명을 알게 됨');

  // 같은 열쇠로 에이전트가 또 들어오면(재시작) 이전 연결을 대체
  const ag3 = await post('agent/join', { key, name: '노트북' });
  ok((await sendFrame(ag2.token, jpeg('F7'))).code === 401, '에이전트가 새로 들어오면 이전 에이전트 입장권은 무효 (한 열쇠에 에이전트 하나)');
  ok(ag3.status === 200, '새 에이전트 입장');

  for (const l of [la, la2, lv3]) l.close();
  for (const t of [ag3.token, v3.token]) await fetch(`${B}/api/remote/leave?token=${t}`, { method: 'POST' });
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
