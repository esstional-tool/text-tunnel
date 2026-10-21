// 원격 화질·속도 자동 조절 + 코덱 선택 실제 시험 (이슈 #25) — Windows 전용. 먼저 agent\build-agent.cmd 로 빌드해 둘 것.
//   node tests/remote-adapt.test.js http://localhost:8787
// 진짜 에이전트(--fake-screen 합성 화면)가 "지연 프록시"를 거쳐 서버에 접속한다. 프록시가 화면 올리기(POST /frame)를 일부러 늦추면
// 에이전트가 스스로 화질을 내리고 간격을 늘리는지, 풀리면 되돌아오는지, 프로필이 반영되는지, 조각마다 PNG/JPEG 중 작은 것을 고르는지 확인한다.
// ⚠ tests/pair.test.js 뒤에는 돌리지 말 것 (IP 차단 → 짝 코드를 못 받음).
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2];
const EXE = path.join(__dirname, '..', 'agent', 'remote-agent.exe');
const PIN = '482915';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));

// 지연 프록시: 화면 올리기만 delay 만큼 늦춘다. 나머지(SSE 포함)는 그대로 전달
let delay = 0;
function startProxy() {
  const target = new URL(B);
  const srv = http.createServer((req, res) => {
    const go = () => {
      const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on('error', () => { try { res.destroy(); } catch {} });
      req.pipe(up);
      res.on('close', () => up.destroy());
    };
    if (req.method === 'POST' && req.url.startsWith('/api/remote/frame') && delay) { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => setTimeout(() => { req.unpipe?.(); const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: 'POST', headers: { ...req.headers, 'content-length': Buffer.concat(chunks).length } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); }); up.on('error', () => { try { res.destroy(); } catch {} }); up.end(Buffer.concat(chunks)); }, delay)); }
    else go();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
function listen(p, token) {
  const events = []; const ac = new AbortController();
  fetch(`${B}/api/remote/${p}?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) { const e = JSON.parse(d); events.push(e); } }
    }
  }).catch(() => {});
  return { events, close: () => ac.abort(), last: (t) => events.filter((e) => e.type === t).pop(), all: (t) => events.filter((e) => e.type === t) };
}
function parse(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'TTF1') return null;
  const out = { seq: buf.readUInt32BE(4), w: buf.readUInt16BE(8), h: buf.readUInt16BE(10), rects: [] };
  const n = buf.readUInt16BE(12); let o = 14;
  for (let i = 0; i < n; i++) { const len = buf.readUInt32BE(o + 8); out.rects.push({ x: buf.readUInt16BE(o), y: buf.readUInt16BE(o + 2), w: buf.readUInt16BE(o + 4), h: buf.readUInt16BE(o + 6), buf: buf.subarray(o + 12, o + 12 + len) }); o += 12 + len; }
  return out;
}
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b) => b[0] === 0xff && b[1] === 0xd8;

(async () => {
  if (!fs.existsSync(EXE)) { console.log('FAIL 에이전트가 빌드되어 있지 않아요 (agent\\build-agent.cmd)'); process.exit(1); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-adapt-'));
  const screen = (...lines) => { const t = path.join(dir, 'fs.tmp'); fs.writeFileSync(t, ['size 1280 720', ...lines].join('\n')); for (let i = 0; i < 10; i++) { try { fs.renameSync(t, path.join(dir, 'fake-screen.txt')); return; } catch {} } };
  screen();
  const { srv, port } = await startProxy();
  let agent, anim = null, step = 0, lv, vt, lastSeq = 0, pulling = false, pullAgain = false;
  const pull = async () => { // 보는 사람: 알림이 오면 바로 가져가 따라잡는다 (못 따라온다는 신호를 만들지 않으려고)
    if (pulling) { pullAgain = true; return; } pulling = true;
    try { do { pullAgain = false; const r = await fetch(`${B}/api/remote/frame?token=${vt}&since=${lastSeq}`); if (r.status === 200) { const p = parse(Buffer.from(await r.arrayBuffer())); if (p) lastSeq = p.seq; } } while (pullAgain); } catch {} finally { pulling = false; }
  };
  const startAnim = () => { anim = setInterval(() => screen(`rect ${40 + (step++ % 20) * 50} 100 60 60 255 120 0`), 150); };
  const stopAnim = () => { clearInterval(anim); anim = null; };
  const stats = () => lv.last('stats');
  const waitStats = async (pred, ms) => { for (let i = 0; i < ms / 100; i++) { if (stats() && pred(stats())) return true; await sleep(100); } return false; };
  try {
    const pair = await post('pair/start', {});
    agent = spawn(EXE, ['--server', `http://127.0.0.1:${port}`, '--config', dir, '--code', pair.code, '--set-pin', PIN, '--quiet', '--fake-screen', dir], { stdio: 'ignore' });
    await sleep(3500);
    const j = await post('remote/view/join', { key: pair.key }); vt = j.token;
    lv = listen('view/events', vt); await sleep(300);
    var lvOn = setInterval(() => { const f = lv.last('frame'); if (f && f.seq > lastSeq) pull(); }, 60);
    for (let t = 0; t < 8; t++) { const r = await post(`remote/view/auth?token=${vt}`, { pin: PIN }); if (r.status !== 409) break; await sleep(1000); }
    for (let i = 0; i < 60 && !lv.last('auth'); i++) await sleep(100);
    ok(lv.last('auth')?.ok === true, 'PIN 통과 (지연 프록시를 거친 진짜 에이전트)');
    startAnim();

    // A) 빠른 네트워크: 화질이 위로 올라간다
    ok(await waitStats((s) => s.q >= 80 && s.mode === 'auto', 15000), `빠를 때는 화질이 올라감 (화질 ${stats()?.q}, 간격 ${stats()?.interval}ms)`);
    ok(stats().interval <= 200 && stats().ms < 200, `간격은 짧고 전송은 빠름 (간격 ${stats().interval}ms, 전송 ${stats().ms}ms)`);

    // B) 느린 네트워크 흉내: 올리는 데 0.9초씩 걸림 → 화질↓ 간격↑
    delay = 900;
    ok(await waitStats((s) => s.q <= 45 && s.interval >= 350, 25000), `느려지면 스스로 화질을 낮추고 간격을 늘림 (화질 ${stats()?.q}, 간격 ${stats()?.interval}ms, 전송 ${stats()?.ms}ms)`);
    ok(stats().ms >= 400, `측정한 전송 시간이 실제로 길어짐 (${stats().ms}ms)`);

    // C) 풀리면 되돌아옴
    delay = 0;
    ok(await waitStats((s) => s.q >= 70 && s.interval <= 250, 40000), `풀리면 다시 화질을 올리고 간격을 줄임 (화질 ${stats()?.q}, 간격 ${stats()?.interval}ms)`);

    // D) 프로필
    await post(`remote/view/profile?token=${vt}`, { mode: 'speed' });
    ok(await waitStats((s) => s.mode === 'speed' && s.w === 960, 8000) && stats().q <= 50, `속도 우선: 화질 상한이 낮아지고 화면 가로가 960px 로 줄어듦 (화질 ${stats()?.q}, ${stats()?.w}px)`);
    ok(lv.last('frame') && (await (async () => { await sleep(1200); const r = await fetch(`${B}/api/remote/frame?token=${vt}&since=0`); const p = parse(Buffer.from(await r.arrayBuffer())); return p.w === 960; })()), '서버가 주는 화면 크기도 960 으로 바뀜 (프로필 변경 시 전체 화면부터 다시 보냄)');
    await post(`remote/view/profile?token=${vt}`, { mode: 'quality' });
    ok(await waitStats((s) => s.mode === 'quality' && s.q >= 70, 25000), `화질 우선: 화질이 높게 유지됨 (화질 ${stats()?.q}, ${stats()?.w}px)`);
    await post(`remote/view/profile?token=${vt}`, { mode: 'auto' });
    ok(await waitStats((s) => s.mode === 'auto' && s.w === 1280, 8000), '자동으로 되돌리면 원래 크기(1280)로 돌아옴');

    // E) 코덱: 조각마다 JPEG/PNG 중 작은 것
    stopAnim(); clearInterval(lvOn); await sleep(1500); // 이제부터는 시험이 직접 가져온다 (자동 가져오기를 멈춤)
    screen(); await sleep(1500); // 바탕만
    { const rr = await fetch(`${B}/api/remote/frame?token=${vt}&since=${lastSeq}`); if (rr.status === 200) lastSeq = parse(Buffer.from(await rr.arrayBuffer())).seq; }
    const before = stats();
    screen('rect 70 70 50 50 255 0 0'); // 단색 → PNG 가 훨씬 작음
    for (let i = 0; i < 30 && (lv.last('frame')?.seq || 0) <= lastSeq; i++) await sleep(100);
    let r = await fetch(`${B}/api/remote/frame?token=${vt}&since=${lastSeq}`); let p = parse(Buffer.from(await r.arrayBuffer())); lastSeq = p.seq;
    ok(p.rects.length >= 1 && p.rects.every((x) => isPng(x.buf)), `색이 단순한 조각은 PNG 로 감 (${p.rects.map((x) => (isPng(x.buf) ? 'PNG' : 'JPEG') + ' ' + x.buf.length + 'B').join(', ')})`);
    screen('rect 70 70 50 50 255 0 0', 'noise 640 360 128 128 7'); // 사진처럼 복잡 → JPEG 가 훨씬 작음
    for (let i = 0; i < 30 && (lv.last('frame')?.seq || 0) <= lastSeq; i++) await sleep(100);
    r = await fetch(`${B}/api/remote/frame?token=${vt}&since=${lastSeq}`); p = parse(Buffer.from(await r.arrayBuffer())); lastSeq = p.seq;
    ok(p.rects.length >= 1 && p.rects.every((x) => isJpg(x.buf)), `복잡한 조각(잡음)은 JPEG 로 감 (${p.rects.map((x) => (isPng(x.buf) ? 'PNG' : 'JPEG') + ' ' + x.buf.length + 'B').join(', ')})`);
    await sleep(2300);
    ok(stats().png > before.png && stats().jpg > before.jpg, `상태 표시에 PNG·JPEG 조각 수가 함께 집계됨 (PNG ${stats().png}, JPEG ${stats().jpg})`);
  } catch (e) { console.log('ERROR', e); }
  stopAnim(); agent?.kill(); try { lv?.close(); } catch {} srv.close();
  if (vt) await fetch(`${B}/api/remote/leave?token=${vt}`, { method: 'POST' }).catch(() => {});
  process.exit(0);
})();
