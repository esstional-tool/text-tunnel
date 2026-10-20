// 업로드 이어 올리기 시험 (이슈 #11): node tests/upload.test.js http://localhost:8787
const crypto = require('crypto');
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const status = (token, uid) => fetch(`${B}/api/upload?${new URLSearchParams({ token, uid })}`).then(async (r) => ({ code: r.status, ...(await r.json().catch(() => ({}))) }));
const chunk = (token, uid, buf, offset, size) => fetch(`${B}/api/upload?${new URLSearchParams({ token, uid, offset, total: buf.length, name: 'r.jpg' })}`,
  { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: buf.subarray(offset, offset + size) }).then(async (r) => ({ code: r.status, text: await r.text() }));

(async () => {
  const { key } = await post('pair/start', {});
  const a = await post('join', { key, name: 'PC', device: 'up-a' });
  const MB = 1024 * 1024;
  const buf = crypto.randomBytes(20 * MB);
  const uid = crypto.randomUUID();

  ok((await status(a.token, uid)).code === 404, '모르는 업로드는 404 (처음부터 올리라는 뜻)');
  ok((await chunk(a.token, uid, buf, 0, 8 * MB)).text === 'more', '첫 조각 8MB');
  const s1 = await status(a.token, uid);
  ok(s1.code === 200 && s1.received === 8 * MB && s1.total === buf.length, `받은 위치 알려 줌 (${s1.received / MB}MB / ${s1.total / MB}MB)`);

  // 연결이 끊겨 앱이 위치를 모르고 엉뚱한 곳부터 보내면 409 → 위치를 물어 이어서
  ok((await chunk(a.token, uid, buf, 16 * MB, 4 * MB)).code === 409, '어긋난 위치로 보내면 409');
  const s2 = await status(a.token, uid);
  ok((await chunk(a.token, uid, buf, s2.received, 8 * MB)).text === 'more', '물어본 위치부터 이어서 올리기');
  ok((await chunk(a.token, uid, buf, 16 * MB, 4 * MB)).text === 'done', '마지막 조각 → 완료');

  // 마지막 응답이 끊겼다고 가정하고 다시 물으면 '다 받았다' — 다시 올려 중복되지 않게
  const s3 = await status(a.token, uid);
  ok(s3.code === 200 && s3.done === true, '완료 뒤 물으면 done (중복 업로드 방지)');

  // 다시 입장(새 입장권)해도 같은 방이면 진행 중인 업로드를 이어서 할 수 있다
  const b = await post('join', { key, name: '휴대폰', device: 'up-b' }); // 방 유지용
  const uid2 = crypto.randomUUID();
  await chunk(a.token, uid2, buf, 0, 8 * MB);
  const a2 = await post('join', { key, name: 'PC', device: 'up-a' });   // 같은 기기 재입장 → 옛 입장권 무효
  ok((await chunk(a.token, uid2, buf, 8 * MB, 8 * MB)).code === 401, '옛 입장권으로는 401');
  const s4 = await status(a2.token, uid2);
  ok(s4.received === 8 * MB, '새 입장권으로 같은 업로드 위치 확인 (재입장 후 이어 올리기)');

  for (const t of [a2.token, b.token]) await fetch(`${B}/api/leave?token=${t}`, { method: 'POST' });
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
