// 유령 자리 정리 시험: 서버를 STALE_SEC=3 으로 띄운 뒤 node tests/rejoin.test.js http://localhost:8787
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
function listen(token) {
  const events = []; const ac = new AbortController();
  fetch(`${B}/api/events?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder();
    for await (const c of r.body) for (const l of dec.decode(c).split('\n')) if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6)));
  }).catch(() => {});
  return { events, close: () => ac.abort() };
}
const names = (l) => l.events.filter((e) => e.type === 'presence').pop()?.users.map((u) => u.name) || [];

(async () => {
  const { key } = await post('pair/start', {});
  const pc = await post('join', { key, name: 'PC', device: 'pc' });
  const old = await post('join', { key, name: '옛휴대폰', device: 'phone-old' });
  const lpc = listen(pc.token), lold = listen(old.token);
  await sleep(800);
  ok(names(lpc).length === 2, `처음 2명 (${names(lpc)})`);

  // 휴대폰이 열쇠를 잃고 다른 기기 ID로 다시 들어옴. 옛 자리는 연결이 살아 있는 척하는 유령
  const fresh = await post('join', { key, name: '휴대폰', device: 'phone-new' });
  ok(fresh.status === 409, '바로는 꽉 차서 409');

  // PC만 계속 살아 있다는 신호를 보낸다
  const hb = setInterval(() => fetch(`${B}/api/ping?token=${pc.token}`), 1000);
  await sleep(4000);
  const again = await post('join', { key, name: '휴대폰', device: 'phone-new' });
  ok(again.status === 200, '신호 끊긴 유령 자리를 비우고 입장');
  const lnew = listen(again.token);
  await sleep(800);
  ok(names(lpc).sort().join() === ['PC', '휴대폰'].sort().join(), `PC와 새 휴대폰 (${names(lpc)})`);
  ok((await fetch(`${B}/api/ping?token=${old.token}`)).status === 401, '유령 입장권은 무효');
  ok((await fetch(`${B}/api/ping?token=${pc.token}`)).status === 200, '살아 있던 PC는 그대로');

  clearInterval(hb);
  for (const l of [lpc, lold, lnew]) l.close();
  process.exit(0);
})();
