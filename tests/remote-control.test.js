// 원격조종 "마우스·키보드 입력" 서버 시험 (이슈 #23): node server.js 로 띄운 뒤
//   node tests/remote-control.test.js http://localhost:8787
// 가짜 에이전트가 PIN 확인·조종 허용 상태 알림·입력 수신을 맡는다.
// 확인하는 것: 조종 허용 전엔 입력 거절 · PIN 전엔 거절 · 허용+켜기 후에만 전달 · 이상한 입력은 버림 · 한도 · 끄면 즉시 중단
const crypto = require('crypto');
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/remote/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));
const PIN = '482915';

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
// 가짜 에이전트: PIN 을 확인해 주고, 받은 입력을 모아 둔다
function agent(token) {
  const st = { inputs: [] };
  const l = listen('agent/events', token, async (e) => {
    if (e.type === 'auth') await post(`agent/auth?token=${token}`, { vid: e.vid, ok: e.pin === PIN, left: 4, code: e.pin === PIN ? '' : 'wrong' });
    if (e.type === 'input') st.inputs.push(...e.ev.map((x) => ({ ...x, vid: e.vid })));
  });
  return { ...l, st, allow: (allowed) => post(`agent/control?token=${token}`, { allowed }) };
}
const input = (token, ev) => post(`view/input?token=${token}`, { ev });
const control = (token, on) => post(`view/control?token=${token}`, { on });
async function viewer(key) {
  const j = await post('view/join', { key });
  const l = listen('view/events', j.token);
  await sleep(250);
  return { token: j.token, ...l };
}
async function login(v) { await post(`view/auth?token=${v.token}`, { pin: PIN }); await sleep(350); }

(async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  const ag = await post('agent/join', { key, name: '노트북' });
  const la = agent(ag.token);
  await sleep(300);

  const v1 = await viewer(key);
  ok(v1.last('control')?.allowed === false && v1.last('control')?.on === false, '입장하면 "조종 불가" 상태를 받음 (에이전트가 아직 허용 안 함)');

  // ── PIN 전 ───────────────────────────────────────
  ok((await control(v1.token, true)).status === 403, 'PIN 전에는 조종을 켤 수 없음 (403)');
  ok((await input(v1.token, [{ t: 'm', x: 0.5, y: 0.5 }])).status === 403, 'PIN 전에는 입력을 보낼 수 없음 (403)');
  await login(v1);
  ok(v1.last('auth')?.ok === true, 'PIN 통과');

  // ── 에이전트가 허용하기 전 ─────────────────────────
  const noAllow = await control(v1.token, true);
  ok(noAllow.status === 409 && /허용/.test(noAllow.error || ''), `주인이 허용하지 않았으면 조종 켜기 거절 (409: ${noAllow.error})`);
  ok((await input(v1.token, [{ t: 'm', x: 0.5, y: 0.5 }])).status === 409, '조종이 꺼져 있으면 입력 거절 (409)');
  ok(la.st.inputs.length === 0, '에이전트에는 아무 입력도 전달되지 않음');

  // ── 에이전트가 허용 ─────────────────────────────
  await la.allow(true); await sleep(300);
  ok(v1.last('control')?.allowed === true && v1.last('control')?.on === false, '주인이 허용하면 보는 쪽에 "조종 가능(아직 꺼짐)" 알림');
  ok((await input(v1.token, [{ t: 'm', x: 0.5, y: 0.5 }])).status === 409, '허용되어도 보는 사람이 켜기 전에는 입력 거절 (409)');
  const on = await control(v1.token, true);
  ok(on.status === 200 && on.on === true, '보는 사람이 조종 켜기 → 켜짐');
  await sleep(250);
  ok(la.last('viewers')?.controllers === 1, '에이전트가 "조종하는 사람 1명" 을 알게 됨 (띠 문구용)');

  // ── 입력 전달·정리 ───────────────────────────────
  const r1 = await input(v1.token, [
    { t: 'm', x: 0.25, y: 0.75 },
    { t: 'd', x: 2, y: -1, b: 0 },          // 좌표는 0~1 로 잘림
    { t: 'u', x: 0.5, y: 0.5, b: 0 },
    { t: 'w', dx: 0, dy: 99999 },           // 휠은 ±2000 으로 잘림
    { t: 'k', vk: 65, d: 1, e: 0 },
    { t: 'k', vk: 65, d: 0, e: 0 },
  ]);
  await sleep(300);
  ok(r1.status === 200 && r1.sent === 6, `정상 입력 6개 전달 (sent ${r1.sent})`);
  const got = la.st.inputs;
  ok(got.length === 6 && got.every((x) => x.vid), '에이전트가 6개를 받았고 모두 보낸 사람(vid) 표시가 붙음');
  ok(got[1].x === 1 && got[1].y === 0, '범위를 벗어난 좌표는 0~1 로 잘려서 전달');
  ok(got[3].dy === 2000, '휠 값은 ±2000 으로 제한');
  ok(got[4].t === 'k' && got[4].vk === 65 && got[4].d === 1, '키 이벤트가 그대로 전달');

  const before = la.st.inputs.length;
  const r2 = await input(v1.token, [
    { t: 'x' }, { t: 'm', x: 'a', y: 1 }, { t: 'k', vk: 999, d: 1 }, { t: 'k', vk: 0, d: 1 }, null, 5, { t: 'd', x: 0.1, y: 0.1, b: 7 },
    { t: 'm', x: 0.1, y: 0.2 },
  ]);
  await sleep(250);
  ok(r2.sent === 1 && r2.dropped === 7 && la.st.inputs.length === before + 1, `이상한 입력 7개는 버리고 정상 1개만 전달 (sent ${r2.sent}, dropped ${r2.dropped})`);

  const big = Array.from({ length: 500 }, (_, i) => ({ t: 'm', x: (i % 100) / 100, y: 0.5 }));
  const before3 = la.st.inputs.length;
  const r3 = await input(v1.token, big);
  await sleep(300);
  ok(r3.sent <= 120 && la.st.inputs.length - before3 <= 120, `한 묶음은 최대 120개까지만 (sent ${r3.sent})`);

  const huge = await fetch(`${B}/api/remote/view/input?token=${v1.token}`, { method: 'POST', body: JSON.stringify({ ev: [], pad: 'x'.repeat(40000) }) });
  ok(huge.status === 413, '입력 묶음이 너무 크면 거절 (413)');

  // 초당 한도: 짧은 시간에 아주 많이 보내면 일부는 버려진다
  let totalSent = 0;
  for (let i = 0; i < 20; i++) { const r = await input(v1.token, big.slice(0, 100)); totalSent += r.sent || 0; }
  ok(totalSent < 20 * 100 && totalSent > 0, `짧은 시간에 2000개를 보내면 한도에서 잘림 (전달 ${totalSent}/2000)`);

  // 한도가 바닥나도 "떼기"(키 올림·버튼 뗌·전체 떼기)는 통과해야 한다 — 버려지면 원격 PC 에서 키가 눌린 채 남는다
  const nUp = la.st.inputs.length;
  const rUp = await input(v1.token, [{ t: 'm', x: 0.1, y: 0.1 }, { t: 'k', vk: 65, d: 0, e: 0 }, { t: 'u', x: 0.1, y: 0.1, b: 0 }, { t: 'r' }]);
  await sleep(250);
  ok(rUp.sent >= 3 && la.st.inputs.slice(nUp).some((x) => x.t === 'k' && !x.d) && la.st.inputs.slice(nUp).some((x) => x.t === 'r'), `한도가 바닥나도 떼기 이벤트는 전달됨 (sent ${rUp.sent})`);

  // ── 다른 보는 사람 ───────────────────────────────
  const v2 = await viewer(key); await login(v2);
  ok((await input(v2.token, [{ t: 'm', x: 0.1, y: 0.1 }])).status === 409, '조종을 켜지 않은 다른 보는 사람의 입력은 거절');
  await sleep(200);
  ok(la.last('viewers')?.count === 2 && la.last('viewers')?.controllers === 1, '보는 사람 2명 중 조종은 1명으로 집계');

  // ── 끄기 ────────────────────────────────────────
  const off = await control(v1.token, false);
  ok(off.status === 200 && off.on === false, '보는 사람이 조종을 끔');
  const n4 = la.st.inputs.length;
  ok((await input(v1.token, [{ t: 'm', x: 0.3, y: 0.3 }])).status === 409 && la.st.inputs.length === n4, '끈 뒤의 입력은 전달되지 않음');

  // ── 주인이 허용을 끄면 모두 즉시 꺼짐 ─────────────────
  await control(v1.token, true); await control(v2.token, true);
  await sleep(250);
  ok(la.last('viewers')?.controllers === 2, '두 사람이 조종 중');
  await la.allow(false); await sleep(300);
  ok(v1.last('control')?.allowed === false && v1.last('control')?.on === false && v2.last('control')?.on === false, '주인이 허용을 끄면 모든 보는 사람의 조종이 즉시 꺼짐');
  ok(la.last('viewers')?.controllers === 0, '에이전트의 조종 인원도 0');
  const n5 = la.st.inputs.length;
  ok((await input(v2.token, [{ t: 'm', x: 0.3, y: 0.3 }])).status === 409 && la.st.inputs.length === n5, '허용이 꺼진 뒤에는 입력이 거절·미전달');
  ok((await control(v1.token, true)).status === 409, '허용이 꺼진 뒤에는 다시 켤 수 없음');

  // ── 에이전트가 사라지면 조종도 사라진다 ─────────────────
  await la.allow(true); await sleep(250); await control(v1.token, true);
  la.close(); await fetch(`${B}/api/remote/leave?token=${ag.token}`, { method: 'POST' }); await sleep(400);
  ok(v1.last('agent')?.online === false && v1.last('control')?.on === false, '에이전트가 사라지면 조종 상태도 꺼짐');
  ok((await input(v1.token, [{ t: 'm', x: 0.3, y: 0.3 }])).status === 403, '에이전트가 사라지면 인증도 풀려 입력 거절 (403)');

  for (const t of [v1.token, v2.token]) await fetch(`${B}/api/remote/leave?token=${t}`, { method: 'POST' });
  v1.close(); v2.close();
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
