// 원격 에이전트 실제 시험 (이슈 #17, #19, #21) — Windows 전용. 먼저 agent\build-agent.cmd 로 빌드해 둘 것.
//   node tests/remote-agent.test.js http://localhost:8787
// ⚠ 에이전트가 이 PC 의 실제 화면을 찍어 **지정한 서버**로 보낸다. 로컬 서버로만 시험할 것.
//   화면 내용은 보지 않고 JPEG 규격(헤더·크기)과 "원격 접속 중" 띠 창만 검사한다. 에이전트는 --quiet 로 띄워 소리·알림이 나지 않게 한다.
// ⚠ tests/pair.test.js 뒤에는 돌리지 말 것 — 그 시험의 마지막 항목이 이 PC 의 IP 를 10분간 짝 코드 차단 상태로 만들어,
//   에이전트가 짝 코드로 열쇠를 받을 수 없다 (서버를 다시 띄우면 풀림). 아래에서 미리 확인해 알려 준다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2];
const EXE = path.join(__dirname, '..', 'agent', 'remote-agent.exe');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PIN = '482915', WRONG = '111111';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// HTTP 상태 코드는 응답 JSON 의 status 필드와 이름이 겹치므로 맨 뒤에 둔다
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));

// 화면 맨 위 "원격 접속 중" 띠 창이 보이는 상태인지
function bannerVisible() {
  const script = `Add-Type 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);}'; $h=[W]::FindWindow([NullString]::Value,'text-tunnel-remote-banner'); if($h -eq [IntPtr]::Zero){'none'}elseif([W]::IsWindowVisible($h)){'visible'}else{'hidden'}`;
  return execFileSync(PS, ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
}
// 띠 창을 일부러 최상위에서 내리거나(drop) 지금 최상위인지 확인 — "다른 창이 덮은 상황"을 흉내 낸다
function topmost(drop) {
  const script = `Add-Type 'using System;using System.Runtime.InteropServices;public class T{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);}'; $h=[T]::FindWindow([NullString]::Value,'text-tunnel-remote-banner'); if($h -eq [IntPtr]::Zero){'none';exit}; ${drop ? '[void][T]::SetWindowPos($h,[IntPtr](-2),0,0,0,0,0x0053);' : ''} if(([T]::GetWindowLong($h,-20) -band 8) -ne 0){'topmost'}else{'normal'}`;
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
// 보는 사람: 입장해서 PIN 을 시도하고 에이전트의 판정을 기다린다
async function viewer(key) {
  const j = await post('remote/view/join', { key });
  const lv = listen('view/events', j.token);
  await sleep(300);
  return {
    token: j.token, lv, agentOnline: j.agentOnline,
    async tryPin(pin) {
      const before = lv.all('auth').length;
      const r = await post(`remote/view/auth?token=${j.token}`, { pin });
      for (let i = 0; i < 60 && lv.all('auth').length === before && r.status === 200; i++) await sleep(100);
      return { http: r.status, ev: lv.all('auth')[before] };
    },
    frames: () => lv.all('frame').length,
    leave: async () => { lv.close(); await fetch(`${B}/api/remote/leave?token=${j.token}`, { method: 'POST' }); },
  };
}
// 에이전트를 새 설정 폴더(또는 지정한 폴더)로 띄운다
async function startAgent({ pin = PIN, cfg, withCode = true } = {}) {
  const dir = cfg || fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agent-'));
  let key;
  const args = ['--server', B, '--config', dir, '--quiet'];
  if (withCode) { const r = await post('pair/start', {}); key = r.key; args.push('--code', r.code); }
  if (pin) args.push('--set-pin', pin);
  const proc = spawn(EXE, args, { stdio: 'ignore' });
  await sleep(3000);
  return { proc, dir, key, kill: () => { try { proc.kill(); } catch {} } };
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('FAIL agent\\remote-agent.exe 가 없어요. agent\\build-agent.cmd 를 먼저 실행하세요'); process.exit(1); }
  // 사전 점검: 이 IP 가 짝 코드 차단 상태면 에이전트가 열쇠를 못 받아 시험이 엉뚱하게 실패한다
  const probe = await fetch(`${B}/api/pair/claim`, { method: 'POST', body: JSON.stringify({ code: 'AAAAAA' }) });
  if (probe.status === 429) { console.log('FAIL 이 PC 의 IP 가 짝 코드 차단 상태예요 (tests/pair.test.js 가 만든 것). 서버를 다시 띄운 뒤 이 시험을 먼저 돌리세요'); process.exit(1); }

  const agents = [];
  try {
    // ═══ 1) 정상 흐름 ═══════════════════════════════
    const a1 = await startAgent(); agents.push(a1);
    ok(fs.existsSync(path.join(a1.dir, 'key.txt')) && fs.readFileSync(path.join(a1.dir, 'key.txt'), 'ascii').trim() === a1.key, '에이전트가 짝 코드로 같은 열쇠를 받아 저장함');
    const pinFile = fs.readFileSync(path.join(a1.dir, 'pin.dat'), 'ascii');
    ok(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(pinFile.trim()) && !pinFile.includes(PIN), 'PIN 은 이 PC 에 해시(솔트:해시)로만 저장되고 평문이 아님');
    ok(bannerVisible() === 'hidden', '보는 사람이 없으면 "원격 접속 중" 띠가 안 보임');

    const v = await viewer(a1.key);
    ok(v.agentOnline === true, '에이전트가 서버에 접속해 대기 중');
    await sleep(2500);
    ok(v.frames() === 0 && bannerVisible() === 'hidden', 'PIN 을 넣기 전에는 열쇠가 있어도 화면이 안 오고 띠도 안 뜸 (인증 전 입장자는 보는 사람으로 세지 않음)');

    const bad = await v.tryPin(WRONG);
    ok(bad.ev?.ok === false && bad.ev.code === 'wrong' && bad.ev.left === 4, `틀린 PIN → 에이전트가 직접 판정해 남은 횟수 4 를 알림 (${JSON.stringify(bad.ev)})`);
    await sleep(1500);
    ok(v.frames() === 0 && bannerVisible() === 'hidden', '틀린 뒤에도 화면은 안 오고 띠도 없음');

    const good = await v.tryPin(PIN);
    ok(good.ev?.ok === true, '맞는 PIN → 에이전트가 인증을 허락함');
    await sleep(3500);
    const frames = v.lv.all('frame');
    ok(frames.length >= 1, `인증되자 에이전트가 화면을 보내기 시작 — 첫 화면은 전체(키 프레임), 이후는 바뀐 곳만이라 정적인 화면에서는 적게 옴 (3.5초에 ${frames.length}번)`);
    ok(bannerVisible() === 'visible', '인증된 사람이 보는 동안 "원격 접속 중" 띠가 화면에 떠 있음');

    // 띠가 다른 창에 가려지는 상황 — 내리는 것과 확인을 한 호출 안에서 한다 (따로 확인하면 그 사이 에이전트가 먼저 올려 버려 의미가 없어진다)
    ok(topmost(false) === 'topmost', '띠가 최상위 창으로 떠 있음');
    ok(topmost(true) === 'normal', '(시험) 띠를 최상위에서 내려 다른 창이 덮은 상황을 만듦 — 내린 직후 상태가 최상위가 아님');
    await sleep(2500);
    ok(topmost(false) === 'topmost', '에이전트가 띠를 다시 최상위로 올려놓음 (덮여도 복구)');

    // 보는 쪽이 받는 신호: agent(온라인)·auth(판정)·frame — 접속 알림 같은 새 종류는 없음
    const kinds = [...new Set(v.lv.events.map((e) => e.type))].sort().join(',');
    ok(kinds === 'agent,auth,control,frame' || kinds === 'agent,auth,control,frame,stats', `보는 쪽이 받는 신호는 agent·auth·control(자기 조종 상태)·frame 뿐 — 접속 알림이 보는 쪽으로 가지 않음 (받은 종류: ${kinds}; stats 는 화질 표시용 상태일 뿐 접속 알림이 아님)`);

    const f = await fetch(`${B}/api/remote/frame?token=${v.token}`);
    const buf = Buffer.from(await f.arrayBuffer());
    const size = jpegSize(buf);
    const ev = v.lv.last('frame');
    ok(buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9, `받은 것이 완전한 JPEG (${Math.round(buf.length / 1024)}KB)`);
    ok(size && size.w <= 1280 && size.w > 0 && size.h > 0, `가로 1280 이하로 줄어 있음 (${size?.w}x${size?.h})`);
    ok(size && ev.w === size.w && ev.h === size.h, '알림에 실린 가로·세로가 실제 JPEG 와 같음');

    // 접속 기록: 결과만, PIN·열쇠는 없음
    const log = fs.readFileSync(path.join(a1.dir, 'access.log'), 'utf8');
    ok(/접속 실패: PIN 이 틀렸어요 \(남은 횟수 4\)/.test(log) && /접속 성공/.test(log), '접속 기록(access.log)에 실패·성공이 남음');
    ok(!log.includes(PIN) && !log.includes(WRONG) && !log.includes(a1.key), '접속 기록에는 PIN·열쇠가 없음 (시각과 결과만)');

    // 보는 사람이 나가면 멈춘다
    await v.leave(); await sleep(2000);
    ok(bannerVisible() === 'hidden', '보는 사람이 나가면 띠가 사라짐');

    // ═══ 2) 에이전트를 껐다 켜도 PIN 이 유지되고, 켤 때마다 다시 인증 ═══
    a1.kill(); await sleep(1500);
    const a1b = await startAgent({ cfg: a1.dir, withCode: false, pin: null }); agents.push(a1b); // --code·--set-pin 없이: 저장된 열쇠와 PIN 으로
    const v2 = await viewer(a1.key);
    ok(v2.agentOnline === true, '저장된 열쇠로 에이전트가 다시 접속함 (코드 없이)');
    ok((await v2.tryPin(PIN)).ev?.ok === true, '껐다 켜도 처음 정한 PIN 이 그대로 유효함');
    await v2.leave(); a1b.kill(); await sleep(1500);

    // ═══ 3) 에이전트 스스로 잠금 (5번 틀리면 10분) ═══
    const a2 = await startAgent(); agents.push(a2);
    const w1 = await viewer(a2.key);
    let last;
    for (let i = 0; i < 5; i++) last = await w1.tryPin(WRONG);
    ok(last.ev?.locked === true && last.ev.code === 'locked' && Number(last.ev.lockedUntil) > Date.now() + 9 * 60 * 1000, `PIN 을 5번 틀리면 에이전트가 10분 잠금을 알림 (잠김 해제 ${Math.round((last.ev?.lockedUntil - Date.now()) / 60000)}분 뒤)`);
    const w2 = await viewer(a2.key); // 새로 들어온 사람 (서버의 틀린 횟수 제한은 아직 안 걸림 — 에이전트가 직접 거절해야 함)
    const locked = await w2.tryPin(PIN);
    ok(locked.http === 200 && locked.ev?.ok === false && locked.ev.code === 'locked', '잠긴 동안은 맞는 PIN 도 에이전트가 거절함');
    await sleep(1500);
    ok(w2.frames() === 0 && bannerVisible() === 'hidden', '잠긴 동안은 화면도 띠도 없음');
    const log2 = fs.readFileSync(path.join(a2.dir, 'access.log'), 'utf8');
    ok(/5번 틀려 10분간 잠금/.test(log2) && /잠금 중 \(맞는 PIN 이어도 거절\)/.test(log2), '잠금과 잠금 중 시도가 접속 기록에 남음');
    await w1.leave(); await w2.leave(); a2.kill(); await sleep(1500);

    // ═══ 4) PIN 을 정하지 않으면 아무도 볼 수 없음 ═══
    const a3 = await startAgent({ pin: null }); agents.push(a3);
    ok(!fs.existsSync(path.join(a3.dir, 'pin.dat')), '(준비) PIN 을 정하지 않은 에이전트');
    const x = await viewer(a3.key);
    const noPin = await x.tryPin(PIN);
    ok(noPin.ev?.ok === false && noPin.ev.code === 'no-pin', 'PIN 을 정하기 전에는 어떤 PIN 을 넣어도 거절 (가장 안전한 기본값)');
    await sleep(1500);
    ok(x.frames() === 0 && bannerVisible() === 'hidden', 'PIN 이 없으면 화면도 띠도 없음');
    ok(/접속 거절: PIN 을 아직 정하지 않았어요/.test(fs.readFileSync(path.join(a3.dir, 'access.log'), 'utf8')), '거절이 접속 기록에 남음');
    await x.leave();

    // 에이전트 종료 → 보는 쪽에서 오프라인
    const y = await viewer(a3.key);
    a3.kill(); await sleep(2500);
    ok(y.lv.last('agent')?.online === false, '에이전트가 꺼지면 보는 쪽이 오프라인으로 바뀜');
    ok(bannerVisible() === 'none', '에이전트가 꺼지면 띠 창도 없음');
    await y.leave();
  } finally {
    for (const a of agents) { a.kill(); try { fs.rmSync(a.dir, { recursive: true, force: true }); } catch {} }
  }
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
