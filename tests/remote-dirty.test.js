// 원격 "바뀐 부분만 보내기" 실제 시험 (이슈 #24) — Windows 전용. 먼저 agent\build-agent.cmd 로 빌드해 둘 것.
//   node tests/remote-dirty.test.js http://localhost:8787
// 진짜 에이전트를 --fake-screen 으로 띄운다: 이 PC 의 실제 화면 대신 폴더의 fake-screen.txt 로 그린 합성 화면(1280x720)을 쓰므로,
// 바뀌는 영역을 정확히 정해서 "그 칸만 조각으로 오는지"를 확인할 수 있고 화면 내용을 읽을 일이 없다.
// ⚠ tests/pair.test.js 뒤에는 돌리지 말 것 (IP 차단 → 짝 코드를 못 받음).
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

function listen(p, token) {
  const events = []; const ac = new AbortController();
  fetch(`${B}/api/remote/${p}?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) events.push({ at: Date.now(), ...JSON.parse(d) }); }
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
function jpegSize(b) {
  let i = 2;
  while (i < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + b.readUInt16BE(i + 2); }
  return null;
}
async function viewer(key) {
  const j = await post('remote/view/join', { key });
  const lv = listen('view/events', j.token); await sleep(300);
  const v = {
    token: j.token, lv,
    async login() { await post(`remote/view/auth?token=${j.token}`, { pin: PIN }); for (let i = 0; i < 60 && lv.last('auth') === undefined; i++) await sleep(100); return lv.last('auth')?.ok === true; },
    async since(n) { const r = await fetch(`${B}/api/remote/frame?token=${j.token}&since=${n}`); return r.status === 200 ? parse(Buffer.from(await r.arrayBuffer())) : { code: r.status }; },
    seq: () => lv.last('frame')?.seq || 0,
    async waitNew(prev, ms = 2500) { for (let i = 0; i < ms / 50 && v.seq() <= prev; i++) await sleep(50); return v.seq() > prev; },
    leave: async () => { lv.close(); await fetch(`${B}/api/remote/leave?token=${j.token}`, { method: 'POST' }); },
  };
  return v;
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('FAIL 에이전트가 빌드되어 있지 않아요 (agent\\build-agent.cmd)'); process.exit(1); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-dirty-'));
  const screen = (...rects) => { // 합성 화면을 바꾼다 (원자적 교체 — 에이전트가 쓰다 만 파일을 읽지 않게)
    const t = path.join(dir, 'fs.tmp');
    fs.writeFileSync(t, ['size 1280 720', ...rects.map((r) => 'rect ' + r.join(' '))].join('\n'));
    for (let i = 0; i < 10; i++) { try { fs.renameSync(t, path.join(dir, 'fake-screen.txt')); return; } catch { require('child_process').execSync('ping -n 1 127.0.0.1 >nul'); } }
  };
  screen();
  let agent, v, v2;
  try {
    const pair = await post('pair/start', {});
    agent = spawn(EXE, ['--server', B, '--config', dir, '--code', pair.code, '--set-pin', PIN, '--quiet', '--fake-screen', dir], { stdio: 'ignore' });
    await sleep(3000);
    v = await viewer(pair.key);
    ok(await v.login(), 'PIN 통과');
    ok(await v.waitNew(0, 4000), '인증되자 에이전트가 첫 화면을 보냄');

    // 1) 첫 화면은 전체(키 프레임)
    let g = await v.since(0);
    ok(g.rects?.length === 1 && g.rects[0].x === 0 && g.rects[0].y === 0 && g.rects[0].w === 1280 && g.rects[0].h === 720, '첫 화면은 전체 화면 한 장 (키 프레임)');
    const keyBytes = g.rects[0].buf.length;
    ok(jpegSize(g.rects[0].buf)?.w === 1280 && jpegSize(g.rects[0].buf)?.h === 720, `키 프레임은 올바른 JPEG (${Math.round(keyBytes / 1024)}KB, 1280x720)`);
    let last = v.seq();

    // 2) 바뀐 게 없으면 아무것도 보내지 않는다
    await sleep(2500);
    ok(v.seq() === last, `화면이 그대로면 2.5초 동안 한 장도 보내지 않음 (프레임 알림 ${v.lv.all('frame').length - 1}개 늘어남)`);

    // 3) 작은 변화 → 그 칸만
    screen([70, 70, 30, 30, 255, 0, 0]);
    ok(await v.waitNew(last), '작은 사각형(30x30)이 바뀌자 새 프레임');
    g = await v.since(last); last = v.seq();
    ok(g.rects.length === 1 && g.rects[0].x === 64 && g.rects[0].y === 64 && g.rects[0].w === 64 && g.rects[0].h === 64, `바뀐 칸 하나만 조각으로 옴 (64,64 크기 64x64): ${JSON.stringify(g.rects.map((r) => [r.x, r.y, r.w, r.h]))}`);
    ok(jpegSize(g.rects[0].buf)?.w === 64 && jpegSize(g.rects[0].buf)?.h === 64, `조각 이미지 크기가 좌표와 같음 (JPEG ${jpegSize(g.rects[0].buf)?.w}x${jpegSize(g.rects[0].buf)?.h}, ${g.rects[0].buf.length}B)`);
    ok(g.rects[0].buf.length * 5 < keyBytes, `조각은 전체 화면보다 훨씬 작음 (${g.rects[0].buf.length}B vs ${keyBytes}B)`);

    // 4) 멀리 떨어진 두 곳 → 조각 둘
    screen([70, 70, 30, 30, 255, 0, 0], [300, 200, 10, 10, 0, 255, 0], [900, 500, 10, 10, 0, 0, 255]);
    ok(await v.waitNew(last), '멀리 떨어진 두 곳이 더 바뀜');
    g = await v.since(last); last = v.seq();
    const set = g.rects.map((r) => `${r.x},${r.y},${r.w},${r.h}`).sort().join(' | ');
    ok(g.rects.length === 2 && set === '256,192,64,64 | 896,448,64,64', `두 곳의 칸만 각각 조각으로 옴: ${set}`);

    // 5) 세로로 이어진 변화는 한 사각형으로 합쳐짐
    screen([70, 70, 30, 30, 255, 0, 0], [300, 200, 10, 10, 0, 255, 0], [900, 500, 10, 10, 0, 0, 255], [130, 0, 40, 200, 250, 250, 0]);
    ok(await v.waitNew(last), '세로로 긴 변화');
    g = await v.since(last); last = v.seq();
    ok(g.rects.length === 1 && g.rects[0].x === 128 && g.rects[0].y === 0 && g.rects[0].w === 64 && g.rects[0].h === 256, `세로로 이어진 칸들은 한 사각형으로 합쳐짐: ${JSON.stringify(g.rects.map((r) => [r.x, r.y, r.w, r.h]))}`);
    // (x=130..170 은 칸 2 (128~191) 한 열, y=0..200 은 칸 0~3 (0~255))

    // 6) 같은 변화가 반복되면(그대로) 또 보내지 않음
    await sleep(1500);
    ok(v.seq() === last, '변화가 멈추면 다시 조용해짐');

    // 7) 화면 대부분이 바뀌면 키 프레임(전체)
    screen([0, 0, 1280, 720, 200, 40, 40]);
    ok(await v.waitNew(last), '화면 전체가 바뀜');
    g = await v.since(0); last = v.seq();
    ok(g.rects.length === 1 && g.rects[0].w === 1280 && g.rects[0].h === 720, '대부분이 바뀌면 조각 대신 전체 화면 한 장으로 교체 (서버가 이전 조각을 모두 버림)');

    // 8) 늦게 들어온 사람은 키 + 지금까지의 조각으로 같은 화면을 받는다
    screen([0, 0, 1280, 720, 200, 40, 40], [640, 360, 50, 50, 10, 200, 10]);
    await v.waitNew(last); last = v.seq();
    v2 = await viewer(pair.key);
    ok(await v2.login(), '두 번째 보는 사람 PIN 통과');
    await sleep(500);
    g = await v2.since(0);
    ok(g.rects.length >= 2 && g.rects[0].w === 1280 && g.rects.slice(1).every((r) => r.x + r.w <= 1280 && r.y + r.h <= 720), `늦게 들어온 사람은 키 프레임 + 조각 ${g.rects.length - 1}개를 받음`);
    await v2.leave(); v2 = null;

    // 9) 오래 안 바뀌어도 주기적으로 전체 화면을 보내 오차를 바로잡는다 (10초)
    const before = v.seq();
    await sleep(11500);
    g = await v.since(0);
    ok(v.seq() > before && g.rects.length === 1 && g.rects[0].w === 1280, `10초 넘게 변화가 없어도 전체 화면을 다시 보냄 (번호 ${before} → ${v.seq()})`);

    // 10) 보는 사람이 모두 나갔다 다시 오면 처음부터(키 프레임)
    await v.leave(); await sleep(1500);
    v = await viewer(pair.key);
    ok(await v.login(), '다시 들어와 PIN 통과');
    ok(await v.waitNew(0, 4000), '다시 들어오자 화면을 다시 보냄');
    g = await v.since(0);
    ok(g.rects.length >= 1 && g.rects[0].w === 1280 && g.rects[0].h === 720, '다시 들어온 사람은 전체 화면부터 받음');
  } catch (e) { console.log('ERROR', e); }
  try { await v?.leave(); } catch {}
  try { await v2?.leave(); } catch {}
  agent?.kill();
  process.exit(0);
})();
