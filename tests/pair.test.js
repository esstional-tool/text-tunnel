// 짝 맺기 시험: node tests/pair.test.js http://localhost:8787
// 마지막 항목은 이 PC 의 IP 를 10분간 짝 코드 차단 상태로 만든다. 실제 서버에서는 SKIP_RL=1 로 건너뛸 것
const crypto = require('crypto');
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

function listen(token) {
  const events = [];
  const ac = new AbortController();
  fetch(`${B}/api/events?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder();
    for await (const c of r.body) for (const l of dec.decode(c).split('\n')) if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6)));
  }).catch(() => {});
  return { events, close: () => ac.abort() };
}
const lastPresence = (l) => l.events.filter((e) => e.type === 'presence').pop()?.users.map((u) => u.name) || [];

(async () => {
  // PC가 QR을 띄움
  const s = await post('pair/start', {});
  ok(s.status === 200 && /^[2-9A-Z]{6}$/.test(s.code) && s.key.length === 43, `짝 코드 발급 (${s.code})`);
  ok((await post('pair/claim', { code: 'AAAAAA' })).status === 404, '틀린 코드 → 404');
  const c = await post('pair/claim', { code: s.code.toLowerCase().replace(/(...)/, '$1 ') });
  ok(c.status === 200 && c.key === s.key, '휴대폰이 코드로 같은 열쇠 받음 (소문자·띄어쓰기 허용)');
  ok((await post('pair/claim', { code: s.code })).status === 404, '같은 코드 두 번 못 씀');

  // 둘 다 열쇠로 입장
  const pc = await post('join', { key: s.key, name: 'PC', device: 'dev-pc' });
  const ph = await post('join', { key: c.key, name: '휴대폰', device: 'dev-phone' });
  ok(pc.status === 200 && ph.status === 200, 'PC·휴대폰 입장');
  const lpc = listen(pc.token), lph = listen(ph.token);
  await sleep(1500);
  ok(lastPresence(lpc).length === 2, `접속자 2명 (${lastPresence(lpc)})`);

  const third = await post('join', { key: s.key, name: '남의폰', device: 'dev-x' });
  ok(third.status === 409, '세 번째 기기는 못 들어옴 (409)');

  await fetch(`${B}/api/send?token=${ph.token}`, { method: 'POST', body: JSON.stringify({ text: '안녕 PC' }) });
  await sleep(500);
  ok(lpc.events.some((e) => e.type === 'msg' && e.text === '안녕 PC'), 'PC가 휴대폰 메시지 받음');

  // 같은 기기가 다시 열면 자리를 이어받는다 (새로고침·앱 재실행)
  const pc2 = await post('join', { key: s.key, name: 'PC', device: 'dev-pc' });
  ok(pc2.status === 200, '같은 기기 재입장 허용');
  ok((await fetch(`${B}/api/ping?token=${pc.token}`)).status === 401, '이전 입장권은 무효');
  const lpc2 = listen(pc2.token);
  await sleep(1500);
  ok(lastPresence(lpc2).length === 2, `재입장 후에도 2명 (${lastPresence(lpc2)})`);

  // 새 기기 연결: 기존 열쇠로 코드 다시 발급
  const s2 = await post('pair/start', { key: s.key });
  const c2 = await post('pair/claim', { code: s2.code });
  ok(c2.key === s.key, '새 기기 연결 시 같은 열쇠 전달');

  // 다른 짝은 서로 안 보임
  const other = await post('pair/start', {});
  const o = await post('join', { key: other.key, name: '남', device: 'dev-o' });
  const lo = listen(o.token); await sleep(800);
  await fetch(`${B}/api/send?token=${pc2.token}`, { method: 'POST', body: JSON.stringify({ text: '비밀' }) });
  await sleep(500);
  ok(!lo.events.some((e) => e.type === 'msg'), '다른 짝에게는 전달 안 됨');

  // 둘 다 나가면 방 폭파 → 다음 입장은 빈 방
  await fetch(`${B}/api/leave?token=${pc2.token}`, { method: 'POST' });
  await fetch(`${B}/api/leave?token=${ph.token}`, { method: 'POST' });
  await sleep(300);
  const again = await post('join', { key: s.key, name: 'PC', device: 'dev-pc' });
  const la = listen(again.token); await sleep(1000);
  ok(again.status === 200 && lastPresence(la).length === 1, '둘 다 나간 뒤 다시 열면 새 방 (1명)');

  ok((await post('join', { key: 'short', name: 'x', device: 'd' })).status === 400, '이상한 열쇠 → 400');

  // 틀린 코드 반복 시 차단
  let last;
  if (process.env.SKIP_RL) { for (const l of [lpc, lph, lpc2, lo, la]) l.close(); process.exit(0); }
  for (let i = 0; i < 12; i++) last = (await post('pair/claim', { code: 'ZZZZZ' + i })).status;
  ok(last === 429, '틀린 코드 반복하면 잠시 차단 (429)');

  for (const l of [lpc, lph, lpc2, lo, la]) l.close();
  process.exit(0);
})();
