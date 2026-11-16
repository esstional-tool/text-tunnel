// 큰 파일 PC 직접 저장 서버 시험 (이슈 #55): 서버를 띄운 뒤
//   node tests/stream.test.js http://localhost:8787
// 메모리 한도보다 큰 파일도 흐르는지 보려면 서버를 MEM_MB=10 으로 띄우고 STREAM_TEST_MB=60 으로 실행한다.
const crypto = require('crypto');
const B = process.argv[2];
const MB = Number(process.env.STREAM_TEST_MB) || 20;
const CH = 8 * 1024 * 1024;
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const get = (p) => fetch(`${B}/api/${p}`).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

function listen(token) {
  const events = [];
  const ac = new AbortController();
  fetch(`${B}/api/events?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder();
    for await (const c of r.body) for (const l of dec.decode(c).split('\n')) if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6)));
  }).catch(() => {});
  return { events, close: () => ac.abort() };
}

// 보내는 쪽 조각 올리기 (응답까지 기다린다). 본문은 raw 바이트
const chunk = (token, sid, offset, buf) => fetch(`${B}/api/stream/chunk?token=${token}&sid=${sid}&offset=${offset}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } })
  .then(async (r) => ({ status: r.status, text: await r.text() }));

(async () => {
  // 짝 맺은 두 기기 (보내는 휴대폰, 받는 PC)
  const s0 = await post('pair/start', {});
  const c0 = await post('pair/claim', { code: s0.code });
  const phone = await post('join', { key: s0.key, name: '휴대폰', device: 'st-phone' });
  const pc = await post('join', { key: s0.key, name: 'PC', device: 'st-pc' });
  const lp = listen(phone.token), lc = listen(pc.token);
  await sleep(600);

  // 보낼 파일 (무작위 바이트) — 내용이 같은지 해시로 확인
  const data = crypto.randomBytes(MB * 1024 * 1024);
  const want = crypto.createHash('sha256').update(data).digest('hex');

  // ── 제안 ──
  ok((await fetch(`${B}/api/stream/offer?token=${phone.token}`, { method: 'POST', body: JSON.stringify({ name: 'big.bin', size: 2 * 1024 * 1024 * 1024 }) })).status === 413, '1GB(기본 한도)를 넘는 제안은 413');
  const off = await fetch(`${B}/api/stream/offer?token=${phone.token}`, { method: 'POST', body: JSON.stringify({ name: 'big.bin', size: data.length, mime: 'application/octet-stream' }) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  ok(off.status === 200 && off.sid, `보내기 제안 (${MB}MB)`);
  await sleep(300);
  ok(lc.events.some((e) => e.type === 'streamoffer' && e.sid === off.sid && e.name === 'big.bin'), 'PC 에 "파일 받기" 제안이 도착');
  ok(!lp.events.some((e) => e.type === 'streamoffer'), '보낸 휴대폰에는 제안이 가지 않음');
  ok((await fetch(`${B}/api/stream/offer?token=${phone.token}`, { method: 'POST', body: JSON.stringify({ name: 'x', size: 10 }) })).status === 409, '한 번에 한 파일만 흐른다 (두 번째 제안은 409)');

  // ── 받는 쪽이 준비되기 전에는 조각을 못 보낸다 ──
  const early = await chunk(phone.token, off.sid, 0, data.subarray(0, 1024));
  ok(early.status === 409, '받는 쪽이 연결하기 전 조각은 409');
  const st0 = await get(`stream/state?token=${phone.token}&sid=${off.sid}`);
  ok(st0.state === 'offered' && st0.received === 0, '상태: offered, 받은 것 0');

  // ── 받는 쪽이 "받기": 연결을 열고, 일부러 잠깐 안 읽어서 밀리는 상황을 만든다 ──
  const recv = [];
  const rr = await fetch(`${B}/api/stream/receive?token=${pc.token}&sid=${off.sid}`);
  ok(rr.status === 200 && rr.headers.get('content-length') === String(data.length), '받기 연결: 200, 파일 크기(Content-Length) 알림');
  const reader = rr.body.getReader();
  await sleep(300);
  ok(lp.events.some((e) => e.type === 'streamready' && e.sid === off.sid), '보내는 휴대폰에 "준비됐어요" 알림');

  // 받는 쪽은 잠깐 기다렸다가(밀리는 상황) 계속 읽는다 — 보내는 쪽 조각 응답이 그동안 늦어져야 한다 (backpressure)
  const reading = (async () => { await sleep(1500); for (;;) { const { done, value } = await reader.read(); if (done) break; recv.push(Buffer.from(value)); } })();
  let offset = 0, last, firstMs = 0;
  while (offset < data.length) {
    const end = Math.min(offset + CH, data.length);
    const t1 = Date.now();
    last = await chunk(phone.token, off.sid, offset, data.subarray(offset, end));
    firstMs = Math.max(firstMs, Date.now() - t1);
    if (last.status !== 200 && last.status !== 0) break;
    if (last.status !== 200) break;
    offset = end;
  }
  ok(last && last.status === 200 && last.text === 'done', '마지막 조각 응답은 done');
  await reading;
  // 밀림(backpressure)은 받는 쪽 버퍼가 찰 때만 보인다. 루프백 버퍼가 크면 0ms 일 수 있어 정보로만 적는다
  console.log(`INFO 가장 오래 기다린 조각 응답: ${firstMs}ms (0 이면 이 PC 의 버퍼가 커서 밀리지 않은 것)`);
  const got = Buffer.concat(recv);
  ok(got.length === data.length && crypto.createHash('sha256').update(got).digest('hex') === want, `받은 파일이 원본과 같음 (${Math.round(got.length / 1024 / 1024)}MB, sha256 일치)`);
  await sleep(400);
  ok(lc.events.some((e) => e.type === 'streamdone' && e.sid === off.sid), 'PC 쪽 흐름이 끝났다는 알림 (streamdone)');
  ok((await get(`stream/state?token=${phone.token}&sid=${off.sid}`)).state === 'gone', '끝난 뒤 상태는 gone (이 파일은 어디에도 남지 않음)');
  ok((await chunk(phone.token, off.sid, 0, data.subarray(0, 10))).status === 410, '끝난 흐름에 조각을 더 보내면 410');

  // ── 취소: 보내는 쪽이 중간에 그만두면 받는 쪽 연결이 끊긴다 ──
  const off2 = await post(`stream/offer?token=${phone.token}`, { name: 'cancel.bin', size: CH * 2 });
  const rr2 = await fetch(`${B}/api/stream/receive?token=${pc.token}&sid=${off2.sid}`);
  const rd2 = rr2.body.getReader();
  await sleep(200);
  await chunk(phone.token, off2.sid, 0, Buffer.alloc(CH, 1));
  await rd2.read(); // 첫 조각은 받았다
  await fetch(`${B}/api/stream/cancel?token=${phone.token}&sid=${off2.sid}`, { method: 'POST' });
  let broke = false;
  try { for (;;) { const { done } = await rd2.read(); if (done) break; } } catch { broke = true; }
  ok(broke, '보내는 쪽이 취소하면 받는 쪽은 파일을 다 받지 못한 오류로 끝남 (완성된 것처럼 보이지 않음)');
  await sleep(300);
  ok(lc.events.some((e) => e.type === 'streamfail' && e.sid === off2.sid && e.reason === 'cancelled'), 'PC 에 취소 알림 (reason: cancelled)');

  // ── 받는 쪽이 끊기면 보내는 쪽이 알 수 있다 ──
  const off3 = await post(`stream/offer?token=${phone.token}`, { name: 'drop.bin', size: CH * 3 });
  const ac3 = new AbortController();
  fetch(`${B}/api/stream/receive?token=${pc.token}&sid=${off3.sid}`, { signal: ac3.signal }).then((r) => r.body.getReader()).then(async (rd) => { await rd.read(); }).catch(() => {});
  await sleep(300);
  ok((await chunk(phone.token, off3.sid, 0, Buffer.alloc(CH, 2))).status === 200, '조각 1 은 받는 쪽이 살아 있는 동안 받아짐');
  ac3.abort(); // 받는 쪽 연결을 끊는다
  await sleep(400);
  const dropped = await chunk(phone.token, off3.sid, CH, Buffer.alloc(CH, 2));
  ok(dropped.status === 410, '받는 쪽이 끊기면 다음 조각은 410 (보내는 쪽에 "받는 쪽이 끊겼어요")');
  ok(lp.events.some((e) => e.type === 'streamfail' && e.sid === off3.sid), '보내는 휴대폰에도 실패 알림');

  // ── 받는 쪽이 아무것도 안 하면 제안은 만료 ──
  ok((await get(`stream/state?token=${phone.token}&sid=${off3.sid}`)).state === 'gone', '실패한 흐름은 남지 않음');

  lp.close(); lc.close();
  await fetch(`${B}/api/leave?token=${phone.token}`, { method: 'POST' });
  await fetch(`${B}/api/leave?token=${pc.token}`, { method: 'POST' });
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
