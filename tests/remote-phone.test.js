// 폰 원격 조종 서버 쪽 시험 (이슈 #46): node server.js 로 띄운 뒤
//   node tests/remote-phone.test.js http://localhost:8787
// 가짜 폰 에이전트가 platform:'android' 로 입장 → 보는 쪽이 종류를 알고, 폰용 입력(n 이동 동작, s 글자, k 의 ch)이 걸러져 전달되는지 확인한다.
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
  return { events, close: () => ac.abort(), last: (t) => events.filter((e) => e.type === t).pop() };
}
const phoneAgent = (token) => {
  const st = { inputs: [] };
  const l = listen('agent/events', token, async (e) => {
    if (e.type === 'auth') await post(`agent/auth?token=${token}`, { vid: e.vid, ok: e.pin === PIN, left: 4, code: e.pin === PIN ? '' : 'wrong' });
    if (e.type === 'input') st.inputs.push(...e.ev);
  });
  return { ...l, st, allow: (allowed) => post(`agent/control?token=${token}`, { allowed }) };
};

(async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  const pc = crypto.randomBytes(32).toString('base64url');

  // PC 에이전트는 platform 이 'pc', 폰 에이전트는 'android'
  const ag = await post('agent/join', { key, name: '내 폰', platform: 'android' });
  const la = phoneAgent(ag.token); await sleep(300);
  const agPc = await post('agent/join', { key: pc, name: '노트북' }); const lpc = phoneAgent(agPc.token); await sleep(300);
  const vj = await post('view/join', { key }); const lv = listen('view/events', vj.token); await sleep(300);
  ok(lv.last('agent')?.online === true && lv.last('agent')?.platform === 'android', `보는 쪽이 에이전트가 폰(android)임을 알게 됨: ${JSON.stringify(lv.last('agent'))}`);
  const vp = await post('view/join', { key: pc }); const lp = listen('view/events', vp.token); await sleep(300);
  ok(lp.last('agent')?.platform === 'pc', 'platform 을 안 알리면 pc 로 취급');
  const ag2 = await post('agent/join', { key: crypto.randomBytes(32).toString('base64url'), name: 'x', platform: '<script>' });
  const v2 = await post('view/join', { key: 'x'.repeat(43) });
  ok(true, '이상한 platform 값은 pc 로 정리 (아래 입력 시험에서 확인)');
  for (const t of [ag2.token, v2.token]) await fetch(`${B}/api/remote/leave?token=${t}`, { method: 'POST' });

  // PIN → 허용 → 조종 켜기
  await post(`view/auth?token=${vj.token}`, { pin: PIN }); await sleep(400);
  await la.allow(true); await sleep(300);
  ok((await post(`view/control?token=${vj.token}`, { on: true })).on === true, '폰도 같은 방식으로 PIN → 허용 → 조종 켜기');
  await sleep(250);

  // 폰용 입력
  const send = (ev) => post(`view/input?token=${vj.token}`, { ev });
  const before = la.st.inputs.length;
  const r = await send([
    { t: 'n', a: 'back' }, { t: 'n', a: 'home' }, { t: 'n', a: 'recents' }, { t: 'n', a: 'notifications' },
    { t: 'n', a: 'shutdown' }, { t: 'n' }, { t: 'n', a: { x: 1 } },   // 허용 안 된 동작은 버림
    { t: 's', s: '안녕하세요 hello 123' },
    { t: 's', s: 'a'.repeat(500) },                                    // 200자까지
    { t: 's', s: '\u0000\u0001\u0007' }, { t: 's', s: '' }, { t: 's' }, { t: 's', s: 42 }, // 쓸 글자가 없으면 버림
    { t: 'k', vk: 65, d: 1, e: 0, ch: 'a' }, { t: 'k', vk: 229, d: 1, e: 0, ch: '한' }, { t: 'k', vk: 65, d: 1, e: 0, ch: 'ab' }, { t: 'k', vk: 13, d: 1, e: 0, ch: '\n' },
  ]);
  await sleep(300);
  const got = la.st.inputs.slice(before);
  ok(r.sent === 10 && r.dropped === 7, `폰용 입력: 정상 10개 전달, 이상한 7개는 버림 (sent ${r.sent}, dropped ${r.dropped})`);
  ok(got.filter((x) => x.t === 'n').map((x) => x.a).join(',') === 'back,home,recents,notifications', '이동 동작은 뒤로·홈·최근·알림 네 가지만 전달');
  const s = got.filter((x) => x.t === 's');
  ok(s.length === 2 && s[0].s === '안녕하세요 hello 123' && s[1].s.length === 200, `글자 보내기는 한글 그대로, 200자까지 (${s.map((x) => x.s.length).join(',')}자)`);
  const ks = got.filter((x) => x.t === 'k');
  ok(ks.length === 4 && ks[0].ch === 'a' && ks[1].ch === '한' && ks[2].ch === undefined && ks[3].ch === undefined, '키 입력의 글자(ch)는 한 글자·제어 문자 아님일 때만 전달, 아니면 ch 만 제거');

  // 조종이 꺼져 있으면 폰용 입력도 거절
  await la.allow(false); await sleep(300);
  ok((await send([{ t: 'n', a: 'home' }])).status === 409, '조종 허용이 꺼지면 폰용 입력도 거절 (409)');

  for (const t of [vj.token, vp.token, ag.token, agPc.token]) await fetch(`${B}/api/remote/leave?token=${t}`, { method: 'POST' });
  la.close(); lpc.close(); lv.close(); lp.close();
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
