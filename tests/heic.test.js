// HEIC 서버 변환 시험 (이슈 #59): 서버를 띄운 뒤
//   node tests/heic.test.js http://localhost:8787
// 실제 HEIC 사진으로 변환까지 보려면 샘플 경로를 준다 (개인 사진이라 저장소에 넣지 않는다):
//   set HEIC_SAMPLE=C:\path\to\photo.heic && node tests/heic.test.js http://localhost:8787
const fs = require('fs');
const crypto = require('crypto');
const { isHeic } = require('../media/heic');
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

// 올리기 (조각 한 번에 전부 — 시험 파일은 작다)
async function upload(token, name, mime, buf) {
  const uid = crypto.randomUUID();
  const r = await fetch(`${B}/api/upload?token=${token}&uid=${uid}&offset=0&total=${buf.length}&name=${encodeURIComponent(name)}`, {
    method: 'POST', body: buf, headers: { 'Content-Type': mime },
  });
  return { status: r.status, text: await r.text() };
}

(async () => {
  // 1) 판별: HEIC 머리글은 HEIC, JPEG·PNG 는 아님
  const fakeHeic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
  const fakeMif = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmif1'), Buffer.alloc(32)]);
  ok(isHeic(fakeHeic) === true, 'ftyp+heic 머리글은 HEIC 로 판단');
  ok(isHeic(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70])) === false, 'JPEG 는 HEIC 가 아님');
  ok(isHeic(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')) === false, 'PNG 는 HEIC 가 아님');
  ok(isHeic(fakeMif) === false, 'mif1(HEIF 일반)만으로는 HEIC 로 보지 않음 (AVIF 등과 구분)');

  // 2) 방 만들기 (보내는 사람 + 받는 사람)
  const s0 = await post('pair/start', {});
  await post('pair/claim', { code: s0.code });
  const a = await post('join', { key: s0.key, name: '보내는이', device: 'h-a' });
  const b = await post('join', { key: s0.key, name: '받는이', device: 'h-b' });
  const lb = listen(b.token);
  await sleep(500);

  // 3) 깨진 HEIC: 변환할 수 없으면 415 로 알리고 방에 올라가지 않는다
  const bad = await upload(a.token, 'IMG_9999.HEIC', 'image/heic', fakeHeic);
  ok(bad.status === 415 && bad.text.includes('JPG'), `깨진 HEIC 는 415 + 안내 (${bad.status})`);
  await sleep(300);
  ok(!lb.events.some((e) => e.type === 'file' && e.fname === 'IMG_9999.HEIC'), '실패한 파일은 상대에게 가지 않음');

  // 4) 진짜 HEIC 샘플이 있으면 변환까지 확인
  const sample = process.env.HEIC_SAMPLE;
  if (!sample || !fs.existsSync(sample)) {
    console.log('SKIP 실제 HEIC 변환 (HEIC_SAMPLE 경로가 없어요)');
  } else {
    const buf = fs.readFileSync(sample);
    ok(isHeic(buf), `샘플이 HEIC 로 판별됨 (${Math.round(buf.length / 1024)}KB)`);
    const up = await upload(a.token, 'IMG_SAMPLE.HEIC', 'image/heic', buf);
    ok(up.status === 200 && up.text === 'done', '샘플 HEIC 업로드 완료');
    await sleep(500);
    const f = lb.events.filter((e) => e.type === 'file').pop();
    ok(f && f.mime === 'image/jpeg' && f.fname === 'IMG_SAMPLE.jpg', `받는 쪽에는 JPG 로 도착 (${f?.fname}, ${f?.mime})`);
    const got = Buffer.from(await (await fetch(`${B}/api/file/${f.fid}?token=${b.token}`)).arrayBuffer());
    ok(got[0] === 0xff && got[1] === 0xd8 && got[2] === 0xff, '내려받은 파일이 실제 JPEG 임 (FF D8 FF)');
    ok(got.length > 1024, `변환된 JPG 크기: ${Math.round(got.length / 1024)}KB`);
  }

  // 5) PC에 바로 저장으로는 HEIC 를 보낼 수 없다 (서버가 조각을 쌓지 않으므로)
  const off = await fetch(`${B}/api/stream/offer?token=${a.token}`, { method: 'POST', body: JSON.stringify({ name: 'IMG_1.HEIC', size: 1000, mime: 'image/heic' }) });
  ok(off.status === 415, 'PC에 바로 저장으로 HEIC 를 보내면 415');

  lb.close();
  await fetch(`${B}/api/leave?token=${a.token}`, { method: 'POST' });
  await fetch(`${B}/api/leave?token=${b.token}`, { method: 'POST' });
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
