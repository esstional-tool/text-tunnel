// 원격 화질·속도 조절 서버 시험 (이슈 #25): node server.js 로 띄운 뒤
//   node tests/remote-quality.test.js http://localhost:8787
// 확인하는 것: 프로필 전달(인증된 사람만·허용된 값만) · 에이전트 상태(stats) 전달·값 정리 · 보는 사람이 못 따라오면 프레임 응답에 slow 표시
const crypto = require('crypto');
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/remote/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));
const PIN = '482915';
const BASE = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const img = (tag) => Buffer.concat([BASE, Buffer.from(tag)]);
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
const agentL = (token) => listen('agent/events', token, async (e) => { if (e.type === 'auth') await post(`agent/auth?token=${token}`, { vid: e.vid, ok: e.pin === PIN, left: 4, code: e.pin === PIN ? '' : 'wrong' }); });
const frame = (token, kind, buf, w = 640, h = 360) => fetch(`${B}/api/remote/frame?token=${token}&w=${w}&h=${h}${kind === 'patch' ? '&kind=patch' : ''}`, { method: 'POST', body: buf }).then((r) => r.text());
const oneRect = (tag) => { const i = img(tag); const h = Buffer.alloc(13); h[0] = 1; h.writeUInt16BE(0, 1); h.writeUInt16BE(0, 3); h.writeUInt16BE(64, 5); h.writeUInt16BE(64, 7); h.writeUInt32BE(i.length, 9); return Buffer.concat([h, i]); };
const since = (token, n) => fetch(`${B}/api/remote/frame?token=${token}&since=${n}`).then((r) => r.status);
async function viewer(key, login = true) {
  const j = await post('view/join', { key }); const l = listen('view/events', j.token); await sleep(250);
  if (login) { await post(`view/auth?token=${j.token}`, { pin: PIN }); await sleep(350); }
  return { token: j.token, ...l };
}

(async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  const ag = await post('agent/join', { key, name: 'n' }); const la = agentL(ag.token); await sleep(300);
  const vNo = await viewer(key, false);
  const v = await viewer(key);

  // ── 프로필 ───────────────────────────────────────
  ok((await post(`view/profile?token=${vNo.token}`, { mode: 'speed' })).status === 403, 'PIN 전에는 프로필을 바꿀 수 없음 (403)');
  ok((await post(`view/profile?token=${v.token}`, { mode: 'turbo' })).status === 400, '허용되지 않은 프로필 값은 거절 (400)');
  ok((await post(`view/profile?token=${v.token}`, { mode: '__proto__' })).status === 400, '이상한 값도 거절 (400)');
  const pr = await post(`view/profile?token=${v.token}`, { mode: 'speed' }); await sleep(250);
  ok(pr.status === 200 && la.last('profile')?.mode === 'speed', '인증된 사람이 고른 프로필이 에이전트에 전달됨 (speed)');
  await post(`view/profile?token=${v.token}`, { mode: 'quality' }); await sleep(200);
  ok(la.last('profile')?.mode === 'quality', '다른 프로필로 바꾸면 그대로 전달 (quality)');
  ok(vNo.all('profile').length === 0, '인증 안 된 사람에게는 아무것도 가지 않음');

  // ── 에이전트 상태 → 보는 사람 ─────────────────────
  const st = await post(`agent/stats?token=${ag.token}`, { mode: 'speed', q: 500, ms: 120.4, interval: 200, png: 3, jpg: 9, w: 960, evil: '<script>' });
  await sleep(250);
  const got = v.last('stats');
  ok(st.status === 200 && got?.mode === 'speed' && got.q === 100 && got.ms === 120 && got.interval === 200 && got.png === 3 && got.jpg === 9 && got.w === 960 && got.evil === undefined, `상태가 값 범위를 정리해 인증된 사람에게 전달됨 (q 500 → ${got?.q}, 모르는 필드는 버림)`);
  ok(vNo.all('stats').length === 0, '인증 안 된 사람에게는 상태도 가지 않음');
  const vLate = await viewer(key);
  ok(vLate.last('stats')?.q === 100, '나중에 인증된 사람은 마지막 상태를 바로 받음');
  ok((await post(`agent/stats?token=${v.token}`, { q: 1 })).status === 401, '보는 사람은 에이전트 상태를 올릴 수 없음 (401)');

  // ── 못 따라오면 slow 표시 ─────────────────────────
  await frame(ag.token, 'key', img('K'));
  await since(v.token, 0); await since(vLate.token, 0); // 둘 다 키까지 가져감
  let r = await frame(ag.token, 'patch', oneRect('p'));
  ok(r === 'ok', `보는 사람이 잘 따라오면 그냥 ok (${r})`);
  let slowAt = 0;
  for (let i = 1; i <= 12 && !slowAt; i++) { r = await frame(ag.token, 'patch', oneRect('q' + i)); if (r.includes('slow')) slowAt = i; }
  ok(slowAt > 0 && slowAt <= 10, `가져가지 않은 조각이 8개를 넘으면 slow 표시 (${slowAt}번째 조각에서: "${r}")`);
  await since(v.token, 0); await since(vLate.token, 0); // 따라잡음
  r = await frame(ag.token, 'patch', oneRect('after'));
  ok(r === 'ok', `다 가져가면 slow 가 사라짐 (${r})`);
  await sleep(1700); // 아무도 안 가져가고 시간이 흐름
  r = await frame(ag.token, 'patch', oneRect('late'));
  ok(r.includes('slow'), `새 것이 있는데 1.5초 넘게 안 가져가면 slow (${r})`);
  await since(v.token, 0); await since(vLate.token, 0);
  const rk = await frame(ag.token, 'key', img('K2'));
  ok(rk === 'ok', `키 프레임 응답도 같은 규칙 (${rk})`);

  for (const t of [v.token, vNo.token, vLate.token, ag.token]) await fetch(`${B}/api/remote/leave?token=${t}`, { method: 'POST' });
  la.close(); v.close(); vNo.close(); vLate.close();
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
