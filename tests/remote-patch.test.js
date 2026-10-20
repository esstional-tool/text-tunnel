// 원격 "바뀐 부분만 보내기" 서버 시험 (이슈 #24): node server.js 로 띄운 뒤
//   node tests/remote-patch.test.js http://localhost:8787
// 가짜 에이전트가 키 프레임·조각 묶음을 올리고, 가짜 보는 사람이 묶음을 받아 형식·번호·상한을 확인한다. (서버는 이미지를 디코딩하지 않는다)
const crypto = require('crypto');
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/remote/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));
const PIN = '482915';
const BASE = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const img = (tag, pad = 0) => Buffer.concat([BASE, Buffer.from(tag), Buffer.alloc(pad, 7)]); // JPEG 로 시작하는 구별용 조각 (크기 조절 가능)

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
function agent(token) {
  return listen('agent/events', token, async (e) => { if (e.type === 'auth') await post(`agent/auth?token=${token}`, { vid: e.vid, ok: e.pin === PIN, left: 4, code: e.pin === PIN ? '' : 'wrong' }); });
}
const postKey = (token, buf, w = 640, h = 360) => fetch(`${B}/api/remote/frame?token=${token}&w=${w}&h=${h}`, { method: 'POST', body: buf }).then(async (r) => ({ code: r.status, text: await r.text() }));
// 조각 묶음 만들기: u8 개수 | 개수 × { u16 x,y,w,h, u32 길이, 이미지 }
function bundle(rects) {
  const parts = [Buffer.from([rects.length])];
  for (const r of rects) { const h = Buffer.alloc(12); h.writeUInt16BE(r.x, 0); h.writeUInt16BE(r.y, 2); h.writeUInt16BE(r.w, 4); h.writeUInt16BE(r.h, 6); h.writeUInt32BE(r.buf.length, 8); parts.push(h, r.buf); }
  return Buffer.concat(parts);
}
const postPatch = (token, buf, w = 640, h = 360) => fetch(`${B}/api/remote/frame?token=${token}&kind=patch&w=${w}&h=${h}`, { method: 'POST', body: buf }).then(async (r) => ({ code: r.status, text: await r.text() }));
// 받은 묶음 해석
function parse(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'TTF1') return null;
  const out = { seq: buf.readUInt32BE(4), w: buf.readUInt16BE(8), h: buf.readUInt16BE(10), rects: [] };
  const n = buf.readUInt16BE(12); let o = 14;
  for (let i = 0; i < n; i++) { const len = buf.readUInt32BE(o + 8); out.rects.push({ x: buf.readUInt16BE(o), y: buf.readUInt16BE(o + 2), w: buf.readUInt16BE(o + 4), h: buf.readUInt16BE(o + 6), buf: buf.subarray(o + 12, o + 12 + len) }); o += 12 + len; }
  return o === buf.length ? out : null;
}
const getSince = async (token, since) => { const r = await fetch(`${B}/api/remote/frame?token=${token}&since=${since}`); return { code: r.status, type: r.headers.get('content-type'), seq: Number(r.headers.get('x-frame-seq')), body: Buffer.from(await r.arrayBuffer()) }; };
async function viewer(key) {
  const j = await post('view/join', { key }); const l = listen('view/events', j.token); await sleep(250);
  return { token: j.token, ...l, async login() { await post(`view/auth?token=${j.token}`, { pin: PIN }); await sleep(350); } };
}

(async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  const ag = await post('agent/join', { key, name: 'n' }); const la = agent(ag.token); await sleep(300);
  const v = await viewer(key);

  ok((await postPatch(ag.token, bundle([{ x: 0, y: 0, w: 64, h: 64, buf: img('a') }]))).text === 'idle', '인증된 보는 사람이 없으면 조각도 받지 않음 (idle)');
  await v.login();
  ok(v.last('auth')?.ok, 'PIN 통과');

  // 기준(키 프레임)이 없으면 조각을 받지 않고 키 프레임을 요청
  ok((await postPatch(ag.token, bundle([{ x: 0, y: 0, w: 64, h: 64, buf: img('a') }]))).text === 'key', '키 프레임이 없으면 조각 대신 키 프레임을 요청 (key)');
  ok((await getSince(v.token, 0)).code === 404, '키 프레임 전에는 화면이 없음 (404)');

  // 키 프레임
  const k = await postKey(ag.token, img('KEY')); await sleep(250);
  ok(k.code === 200 && k.text === 'ok', '키 프레임 접수');
  ok(v.last('frame')?.w === 640 && v.last('frame')?.h === 360, '보는 쪽이 화면 크기가 담긴 새 프레임 알림을 받음');
  const g0 = await getSince(v.token, 0);
  const p0 = parse(g0.body);
  ok(g0.code === 200 && g0.type === 'application/x-tt-frames' && p0 && p0.rects.length === 1 && p0.w === 640 && p0.h === 360, `처음 받는 사람은 키 프레임 한 장 (${p0?.rects.length}개, ${p0?.w}x${p0?.h})`);
  ok(p0.rects[0].x === 0 && p0.rects[0].y === 0 && p0.rects[0].w === 640 && p0.rects[0].h === 360 && p0.rects[0].buf.equals(img('KEY')), '키 프레임은 화면 전체 영역이고 내용이 그대로 전달됨');
  const keySeq = p0.seq;

  // 조각
  const r1 = await postPatch(ag.token, bundle([{ x: 64, y: 64, w: 64, h: 64, buf: img('p1') }, { x: 128, y: 0, w: 128, h: 64, buf: img('p2') }]));
  await sleep(250);
  ok(r1.code === 200 && r1.text === 'ok', '조각 묶음(2개) 접수');
  ok(v.last('frame')?.seq === keySeq + 1, `조각마다 새 번호 알림 (${v.last('frame')?.seq})`);
  const g1 = parse((await getSince(v.token, keySeq)).body);
  ok(g1 && g1.rects.length === 2 && g1.rects[0].x === 64 && g1.rects[1].w === 128 && g1.rects[0].buf.equals(img('p1')), '이미 키 프레임을 받은 사람은 그 뒤 조각 2개만 받음 (좌표·내용 그대로)');
  ok((await getSince(v.token, keySeq + 1)).code === 204, '새 것이 없으면 204 (다시 받을 것 없음)');
  const r2 = await postPatch(ag.token, bundle([{ x: 0, y: 0, w: 64, h: 64, buf: img('p3') }])); await sleep(150);
  const g2 = parse((await getSince(v.token, keySeq + 1)).body);
  ok(r2.text === 'ok' && g2.rects.length === 1 && g2.seq === keySeq + 2 && g2.rects[0].buf.equals(img('p3')), '번호 이후 조각만 순서대로 묶어 줌');

  // 늦게 들어온 사람은 키 + 조각 전부 (순서 보존)
  const v2 = await viewer(key); await v2.login();
  const g3 = parse((await getSince(v2.token, 0)).body);
  ok(g3 && g3.rects.length === 4 && g3.rects[0].w === 640 && g3.rects.slice(1).map((r) => r.buf.toString('latin1').slice(-2)).join(',') === 'p1,p2,p3', `늦게 들어온 사람은 키 프레임 + 조각 3개를 순서대로 (${g3?.rects.length}개)`);
  ok(v2.last('frame')?.seq === keySeq + 2, '인증되는 순간 최신 번호 알림을 받음');
  // 이전 방식(since 없음)은 최신 키 프레임 이미지 그대로
  const legacy = await fetch(`${B}/api/remote/frame?token=${v2.token}`);
  ok(legacy.headers.get('content-type') === 'image/jpeg' && Buffer.from(await legacy.arrayBuffer()).equals(img('KEY')), 'since 없이 받으면 이전 방식 그대로 (키 프레임 이미지)');

  // 잘못된 묶음
  const bad = [
    ['길이 합이 안 맞음', Buffer.concat([bundle([{ x: 0, y: 0, w: 64, h: 64, buf: img('z') }]), Buffer.from([1])])],
    ['화면 밖', bundle([{ x: 600, y: 0, w: 64, h: 64, buf: img('z') }])],
    ['이미지가 아님', bundle([{ x: 0, y: 0, w: 64, h: 64, buf: Buffer.from('not an image at all') }])],
    ['개수 0', Buffer.from([0])],
    ['개수 33', bundle(Array.from({ length: 33 }, () => ({ x: 0, y: 0, w: 8, h: 8, buf: img('z') })))],
    ['크기 0', bundle([{ x: 0, y: 0, w: 0, h: 64, buf: img('z') }])],
  ];
  for (const [name, b] of bad) ok((await postPatch(ag.token, b)).code === 400, `잘못된 조각 묶음 거절 (400): ${name}`);
  ok((await postPatch(ag.token, bundle([{ x: 0, y: 0, w: 64, h: 64, buf: img('z') }]), 800, 600)).text === 'key', '화면 크기가 바뀌면 키 프레임을 요청');
  ok(parse((await getSince(v.token, keySeq + 2)).body) === null || (await getSince(v.token, keySeq + 2)).code === 204, '거절된 조각은 저장되지 않음');

  // 상한: 조각이 쌓이면 새 키 프레임을 요청
  let asked = null;
  for (let i = 0; i < 6 && asked === null; i++) { const r = await postPatch(ag.token, bundle([{ x: 0, y: 0, w: 64, h: 64, buf: img('big' + i, 60 * 1024) }])); if (r.text === 'key') asked = i; }
  ok(asked !== null && asked <= 5, `조각이 키 프레임보다 많이 쌓이면 에이전트에 새 키 프레임을 요청 (${asked !== null ? asked + 1 : '-'}번째 조각에서)`);
  const k2 = await postKey(ag.token, img('KEY2')); await sleep(200);
  const g4 = parse((await getSince(v2.token, 0)).body);
  ok(k2.text === 'ok' && g4.rects.length === 1 && g4.rects[0].buf.equals(img('KEY2')), '새 키 프레임이 오면 이전 키·조각은 모두 버려지고 키 한 장만 남음 (메모리 상한)');
  const g4b = parse((await getSince(v2.token, keySeq + 3)).body); // 옛 번호(새 키보다 앞)를 들고 있던 뒤처진 사람
  ok(g4b.rects.length === 1 && g4b.rects[0].buf.equals(img('KEY2')) && g4b.rects[0].w === 640, '옛 번호를 들고 있던 뒤처진 사람은 조각 없이 새 키 프레임부터 받음');

  // 안전 상한(6MB): 한꺼번에 너무 쌓이면 버리고 키 프레임을 기다림
  await postPatch(ag.token, bundle([{ x: 0, y: 0, w: 64, h: 64, buf: img('h1', 3 * 1024 * 1024) }]));
  const hard = await postPatch(ag.token, bundle([{ x: 0, y: 0, w: 64, h: 64, buf: img('h2', 3 * 1024 * 1024) }]));
  ok(hard.text === 'key' && (await getSince(v.token, 0)).code === 404, '안전 상한(6MB)을 넘으면 모두 버리고 키 프레임을 기다림 (메모리 보호)');

  // 에이전트가 사라지면 화면은 모두 사라진다
  await postKey(ag.token, img('KEY3')); await sleep(150);
  la.close(); await fetch(`${B}/api/remote/leave?token=${ag.token}`, { method: 'POST' }); await sleep(300);
  ok((await getSince(v.token, 0)).code === 403, '에이전트가 사라지면 인증이 풀리고 (화면도 메모리에서 사라짐) 더는 받을 수 없음');

  // 인증 안 된 사람은 받을 수 없다
  const ag2 = await post('agent/join', { key, name: 'n2' }); const la2 = agent(ag2.token); await sleep(300);
  const v3 = await viewer(key);
  ok((await getSince(v3.token, 0)).code === 403, 'PIN 전에는 since 로 요청해도 거절 (403)');
  for (const t of [v.token, v2.token, v3.token, ag2.token]) await fetch(`${B}/api/remote/leave?token=${t}`, { method: 'POST' });
  la2.close(); v.close(); v2.close(); v3.close();
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
