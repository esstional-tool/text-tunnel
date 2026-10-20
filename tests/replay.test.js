// 놓친 메시지 다시 받기 시험 (이슈 #9): 서버를 REPLAY_SEC=3 으로 띄운 뒤 node tests/replay.test.js http://localhost:8787
// REPLAY_SEC 가 기본(120)인 실제 서버에서는 SKIP_EXPIRY=1 로 만료 시험을 건너뛸 것
const crypto = require('crypto');
const B = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

// SSE 를 열고 id·data 를 함께 모은다
function listen(token, last) {
  const events = [];
  const ac = new AbortController();
  const qs = new URLSearchParams({ token, ...(last ? { last } : {}) });
  fetch(`${B}/api/events?${qs}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const id = /^id: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (data) events.push({ id, ...JSON.parse(data) });
      }
    }
  }).catch(() => {});
  return { events, close: () => ac.abort(), replayable: () => events.filter((e) => e.type !== 'presence'), lastId: () => events.filter((e) => e.id).pop()?.id };
}
const say = (token, text) => fetch(`${B}/api/send?token=${token}`, { method: 'POST', body: JSON.stringify({ text }) });
async function upload(token, name) {
  const qs = new URLSearchParams({ token, uid: crypto.randomUUID(), offset: 0, total: 5, name });
  return (await fetch(`${B}/api/upload?${qs}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: 'hello' })).text();
}
const texts = (l) => l.replayable().map((e) => (e.type === 'msg' ? e.text : e.type === 'file' ? `file:${e.fname}` : e.type));

(async () => {
  const { key } = await post('pair/start', {});
  const pc = await post('join', { key, name: 'PC', device: 'pc-1' });
  let ph = await post('join', { key, name: '휴대폰', device: 'ph-1' });
  ok(pc.tag && ph.tag && pc.tag !== ph.tag && ph.replaySec > 0, `입장 응답에 기기 표식·보관 시간 (${ph.tag}, ${ph.replaySec}초)`);
  const lpc = listen(pc.token);
  let lph = listen(ph.token);
  await sleep(800);

  await say(ph.token, 'p1');           // 휴대폰이 보낸 것 (나중에 내 메시지로 보여야 함)
  await say(pc.token, 'm1');
  await sleep(500);
  ok(texts(lph).join() === 'p1,m1' && lph.replayable().every((e) => /^[0-9a-f]{8}:\d+$/.test(e.id)), `이벤트에 번호(id) — ${lph.replayable().map((e) => e.id)}`);
  const lastBefore = lph.lastId();

  // 휴대폰 연결이 끊긴 사이 (화면 꺼짐) PC 가 보냄
  lph.close();
  await sleep(300);
  await say(pc.token, 'm2');
  await say(pc.token, 'm3');
  ok((await upload(pc.token, 'IMG_9.jpg')) === 'done', '끊긴 동안 PC 가 사진도 보냄');
  await sleep(300);

  // 다시 연결: 마지막으로 받은 번호 이후만
  ph = await post('join', { key, name: '휴대폰', device: 'ph-1' });
  lph = listen(ph.token, lastBefore);
  await sleep(800);
  ok(texts(lph).join() === 'm2,m3,file:IMG_9.jpg', `다시 연결하면 놓친 것만 순서대로 (${texts(lph)})`);

  // 최신 번호로 연결하면 다시 받을 것이 없다 (중복 없음)
  const lnone = listen(ph.token, lph.lastId());
  await sleep(600);
  ok(lnone.replayable().length === 0, '이미 받은 번호 이후로는 다시 보내지 않음');
  lnone.close();

  // 앱을 처음 여는 경우(번호 없음): 보관 중인 것 전부, 내가 보낸 p1 은 내 표식
  lph.close();
  ph = await post('join', { key, name: '휴대폰', device: 'ph-1' });
  const lfresh = listen(ph.token);
  await sleep(800);
  ok(texts(lfresh).join() === 'p1,m1,m2,m3,file:IMG_9.jpg', `처음 열면 보관 중인 것 전부 (${texts(lfresh)})`);
  const p1 = lfresh.replayable().find((e) => e.text === 'p1');
  ok(p1?.dev === ph.tag && p1.from !== ph.id, '이전 접속에서 보낸 내 메시지를 표식으로 알아봄');
  lfresh.close();

  // 대화 지우기 이후에는 지운 메시지가 다시 오지 않는다
  await fetch(`${B}/api/clear?token=${pc.token}`, { method: 'POST' });
  await sleep(300);
  ph = await post('join', { key, name: '휴대폰', device: 'ph-1' });
  const lclear = listen(ph.token);
  await sleep(800);
  ok(texts(lclear).join() === 'clear', `지운 뒤 다시 열면 '지우기'만 받음 (${texts(lclear)})`);
  lclear.close();

  if (!process.env.SKIP_EXPIRY) {
    await sleep(3500); // REPLAY_SEC=3
    ph = await post('join', { key, name: '휴대폰', device: 'ph-1' });
    const lexp = listen(ph.token);
    await sleep(800);
    ok(lexp.replayable().length === 0, '보관 시간이 지나면 다시 보내지 않음 (메모리에서 사라짐)');
    lexp.close();
  }

  // 방이 사라졌다 새로 생기면 옛 번호와 섞이지 않는다
  const oldLast = lpc.lastId();
  lpc.close();
  await fetch(`${B}/api/leave?token=${pc.token}`, { method: 'POST' });
  await fetch(`${B}/api/leave?token=${ph.token}`, { method: 'POST' });
  await sleep(300);
  const pc2 = await post('join', { key, name: 'PC', device: 'pc-1' });
  await say(pc2.token, 'n1');
  const lnew = listen(pc2.token, oldLast);
  await sleep(800);
  ok(texts(lnew).join() === 'n1', `새 방에서는 옛 번호를 무시하고 새 메시지를 받음 (${texts(lnew)})`);
  lnew.close();
  await fetch(`${B}/api/leave?token=${pc2.token}`, { method: 'POST' });
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
