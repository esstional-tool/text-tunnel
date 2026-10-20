// 원격 에이전트 실제 시험 (이슈 #17) — Windows 전용. 먼저 agent\build-agent.cmd 로 빌드해 둘 것.
//   node tests/remote-agent.test.js http://localhost:8787
// ⚠ 에이전트가 이 PC 의 실제 화면을 찍어 **지정한 서버**로 보낸다. 로컬 서버로만 시험할 것.
// ⚠ tests/pair.test.js 뒤에는 돌리지 말 것 — 그 시험의 마지막 항목이 이 PC 의 IP 를 10분간 짝 코드 차단 상태로 만들어,
//   에이전트가 짝 코드로 열쇠를 받을 수 없다 (서버를 다시 띄우면 풀림). 아래에서 미리 확인해 알려 준다.
//   화면 내용은 보지 않고 JPEG 규격(헤더·크기)과 "원격 접속 중" 띠 창만 검사한다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2];
const EXE = path.join(__dirname, '..', 'agent', 'remote-agent.exe');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

// 화면 맨 위 "원격 접속 중" 띠 창이 보이는 상태인지
function bannerVisible() {
  const script = `Add-Type 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);}'; $h=[W]::FindWindow([NullString]::Value,'text-tunnel-remote-banner'); if($h -eq [IntPtr]::Zero){'none'}elseif([W]::IsWindowVisible($h)){'visible'}else{'hidden'}`;
  return execFileSync(PS, ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
}
// 띠 창을 일부러 최상위에서 내리거나(false), 지금 최상위인지(null) 확인 — "다른 창이 덮은 상황"을 흉내 낸다
function topmost(drop) {
  const script = `Add-Type 'using System;using System.Runtime.InteropServices;public class T{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);}'; $h=[T]::FindWindow([NullString]::Value,'text-tunnel-remote-banner'); if($h -eq [IntPtr]::Zero){'none';exit}; ${drop ? "[void][T]::SetWindowPos($h,[IntPtr](-2),0,0,0,0,0x0053);" : ''} if(([T]::GetWindowLong($h,-20) -band 8) -ne 0){'topmost'}else{'normal'}`;
  return execFileSync(PS, ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
}
// JPEG 가로·세로 (SOF 마커) 읽기
function jpegSize(b) {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
function listen(path, token) {
  const events = []; const ac = new AbortController();
  fetch(`${B}/api/remote/${path}?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) events.push({ at: Date.now(), ...JSON.parse(d) }); }
    }
  }).catch(() => {});
  return { events, close: () => ac.abort(), last: (t) => events.filter((e) => e.type === t).pop() };
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('FAIL agent\\remote-agent.exe 가 없어요. agent\\build-agent.cmd 를 먼저 실행하세요'); process.exit(1); }
  // 사전 점검: 이 IP 가 짝 코드 차단 상태면 에이전트가 열쇠를 못 받아 시험이 엉뚱하게 실패한다
  const probe = await fetch(`${B}/api/pair/claim`, { method: 'POST', body: JSON.stringify({ code: 'AAAAAA' }) });
  if (probe.status === 429) { console.log('FAIL 이 PC 의 IP 가 짝 코드 차단 상태예요 (tests/pair.test.js 가 만든 것). 서버를 다시 띄운 뒤 이 시험을 먼저 돌리세요'); process.exit(1); }
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agent-'));
  let agent;
  try {
    // 메신저에서 "새 기기 연결" 코드를 받는 것과 같다 — PC 가 열쇠를 갖고, 에이전트가 코드로 같은 열쇠를 받는다
    const { code, key } = await post('pair/start', {});
    agent = spawn(EXE, ['--server', B, '--code', code, '--config', cfg, '--quiet'], { stdio: 'ignore' }); // --quiet: 알림 토스트·소리 끔 (띠는 그대로)
    await sleep(2500);
    ok(fs.existsSync(path.join(cfg, 'key.txt')) && fs.readFileSync(path.join(cfg, 'key.txt'), 'ascii').trim() === key, '에이전트가 짝 코드로 같은 열쇠를 받아 저장함');
    ok(bannerVisible() === 'hidden', '보는 사람이 없으면 "원격 접속 중" 띠가 안 보임');

    const v = await post('remote/view/join', { key });
    ok(v.agentOnline === true, '에이전트가 서버에 접속해 대기 중 (보는 쪽에서 온라인으로 보임)');
    const lv = listen('view/events', v.token);
    await sleep(3500);

    const frames = lv.events.filter((e) => e.type === 'frame');
    ok(frames.length >= 5, `보는 사람이 들어오자 에이전트가 화면을 보내기 시작 (3.5초에 ${frames.length}장 ≈ 초당 ${(frames.length / 3.5).toFixed(1)}장)`);
    ok(bannerVisible() === 'visible', '보는 동안 "원격 접속 중" 띠가 화면에 떠 있음');

    // 띠가 다른 창에 가려지는 상황: 일부러 최상위에서 내려도 에이전트가 1초 안팎에 다시 올린다
    ok(topmost(false) === 'topmost', '띠가 최상위 창으로 떠 있음');
    // 내리는 것과 확인을 한 호출 안에서 한다 — 따로 확인하면 PowerShell 이 뜨는 사이 에이전트가 먼저 올려 버려, 복구 시험이 아무것도 시험하지 않게 된다
    ok(topmost(true) === 'normal', '(시험) 띠를 최상위에서 내려 다른 창이 덮은 상황을 만듦 — 내린 직후 상태가 최상위가 아님');
    await sleep(2500);
    ok(topmost(false) === 'topmost', '에이전트가 띠를 다시 최상위로 올려놓음 (덮여도 복구)');

    // 알림·소리는 조종당하는 PC 에서만 — 보는 쪽이 받는 신호에는 agent·frame 만 있다 (새 종류가 없음)
    const kinds = [...new Set(lv.events.map((e) => e.type))].sort().join(',');
    ok(kinds === 'agent,frame', `보는 쪽이 받는 신호는 agent·frame 뿐 — 접속 알림이 보는 쪽으로 가지 않음 (받은 종류: ${kinds})`);

    const f = await fetch(`${B}/api/remote/frame?token=${v.token}`);
    const buf = Buffer.from(await f.arrayBuffer());
    const size = jpegSize(buf);
    const ev = lv.last('frame');
    ok(buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9, `받은 것이 완전한 JPEG (${Math.round(buf.length / 1024)}KB)`);
    ok(size && size.w <= 1280 && size.w > 0 && size.h > 0, `가로 1280 이하로 줄어 있음 (${size?.w}x${size?.h})`);
    ok(size && ev.w === size.w && ev.h === size.h, '알림에 실린 가로·세로가 실제 JPEG 와 같음');
    ok(buf.length < 400 * 1024, `프레임 크기가 현실적 (JPEG 통째 전송의 비용: ${Math.round(buf.length / 1024)}KB × 초당 ${(frames.length / 3.5).toFixed(1)}장 ≈ ${Math.round(buf.length / 1024 * frames.length / 3.5)}KB/s)`);

    // 보는 사람이 나가면 화면 전송을 멈추고 띠가 사라진다
    await fetch(`${B}/api/remote/leave?token=${v.token}`, { method: 'POST' });
    lv.close();
    await sleep(2000);
    ok(bannerVisible() === 'hidden', '보는 사람이 나가면 띠가 사라짐');
    const v2 = await post('remote/view/join', { key });
    const lv2 = listen('view/events', v2.token);
    await sleep(300);
    const before = lv2.events.filter((e) => e.type === 'frame').length;
    // 새로 들어온 사람은 곧 프레임을 받아야 한다 (에이전트가 다시 시작)
    await sleep(2500);
    ok(lv2.events.filter((e) => e.type === 'frame').length > before, '다시 들어오면 화면이 다시 옴');
    await fetch(`${B}/api/remote/leave?token=${v2.token}`, { method: 'POST' });
    lv2.close();

    // 에이전트 종료 → 보는 쪽에서 오프라인
    const v3 = await post('remote/view/join', { key });
    const lv3 = listen('view/events', v3.token);
    await sleep(500);
    agent.kill();
    await sleep(2500);
    ok(lv3.last('agent')?.online === false, '에이전트가 꺼지면 보는 쪽이 오프라인으로 바뀜');
    ok(bannerVisible() === 'none', '에이전트가 꺼지면 띠 창도 없음');
    lv3.close();
    await fetch(`${B}/api/remote/leave?token=${v3.token}`, { method: 'POST' });
  } finally {
    try { agent?.kill(); } catch {}
    fs.rmSync(cfg, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
