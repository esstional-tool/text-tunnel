// 원격 조종 실제 시험 (이슈 #23) — Windows 전용. 먼저 agent\build-agent.cmd 로 빌드해 둘 것.
//   node tests/remote-control-agent.test.js http://localhost:8787
// 1부는 에이전트가 입력을 실제로 넣지 않고 파일에 기록하는 모드(--input-sink)라 화면이 잠겨 있어도 돌고, 2부는 화면이 풀려 있을 때만(잠겨 있으면 SKIP) 진짜 입력을 넣는다.
// ⚠ 2부는 진짜 에이전트가 이 PC 의 마우스 커서를 움직이고 클릭·키 입력을 넣는다. 로컬 서버로만, 자리에 아무도 없거나 지켜볼 때만 돌릴 것.
//   입력은 시험용 "표적 창"(tests/helpers/control-target.ps1) 위에만 보낸다 — 다른 창을 클릭하지 않고, 글자는 숫자만 쓴다(한/영 IME 영향 없음).
//   끝나면 커서를 원래 자리로 돌려놓는다.
// ⚠ tests/pair.test.js 뒤에는 돌리지 말 것 (IP 차단 → 짝 코드를 못 받음). 서버를 다시 띄우면 풀림.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2];
const EXE = path.join(__dirname, '..', 'agent', 'remote-agent.exe');
const TARGET = path.join(__dirname, 'helpers', 'control-target.ps1');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PIN = '482915';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));
const ps = (script) => execFileSync(PS, ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();

const NATIVE = `Add-Type 'using System;using System.Text;using System.Runtime.InteropServices;public class N{[DllImport("user32.dll")]public static extern bool GetCursorPos(out POINT p);[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int k);[DllImport("user32.dll")]public static extern void keybd_event(byte v,byte s,uint f,UIntPtr e);[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern int GetSystemMetrics(int i);[DllImport("user32.dll")]public static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindowEx(IntPtr p,IntPtr a,string c,string t);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int SendMessage(IntPtr h,int m,int w,StringBuilder s);[StructLayout(LayoutKind.Sequential)]public struct POINT{public int X;public int Y;}}'; [void][N]::SetProcessDPIAware();`;
const cursor = () => { const o = ps(`${NATIVE} $p=New-Object N+POINT; [void][N]::GetCursorPos([ref]$p); "$($p.X),$($p.Y)"`).split(',').map(Number); return { x: o[0], y: o[1] }; };
const setCursor = (x, y) => ps(`${NATIVE} [void][N]::SetCursorPos(${x},${y})`);
const keyIsDown = (vk) => ps(`${NATIVE} if(([N]::GetAsyncKeyState(${vk}) -band 0x8000) -ne 0){'down'}else{'up'}`) === 'down';
const panicHotkey = () => ps(`${NATIVE} [N]::keybd_event(0x11,0,0,[UIntPtr]::Zero);[N]::keybd_event(0x12,0,0,[UIntPtr]::Zero);[N]::keybd_event(0x7B,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 80;[N]::keybd_event(0x7B,0,2,[UIntPtr]::Zero);[N]::keybd_event(0x12,0,2,[UIntPtr]::Zero);[N]::keybd_event(0x11,0,2,[UIntPtr]::Zero)`);
const bannerText = () => ps(`${NATIVE} $h=[N]::FindWindow([NullString]::Value,'text-tunnel-remote-banner'); if($h -eq [IntPtr]::Zero){'(없음)'}else{$c=[N]::FindWindowEx($h,[IntPtr]::Zero,[NullString]::Value,[NullString]::Value); $sb=New-Object Text.StringBuilder 400; [void][N]::SendMessage($c,0xD,400,$sb); $sb.ToString()}`);

function listen(p, token) {
  const events = []; const ac = new AbortController();
  fetch(`${B}/api/remote/${p}?token=${token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) events.push(JSON.parse(d)); }
    }
  }).catch(() => {});
  return { events, close: () => ac.abort(), last: (t) => events.filter((e) => e.type === t).pop(), all: (t) => events.filter((e) => e.type === t) };
}
async function viewer(key) {
  const j = await post('remote/view/join', { key });
  const lv = listen('view/events', j.token);
  await sleep(400);
  const v = {
    token: j.token, lv,
    async login() { const before = lv.all('auth').length; await post(`remote/view/auth?token=${j.token}`, { pin: PIN }); for (let i = 0; i < 60 && lv.all('auth').length === before; i++) await sleep(100); return lv.last('auth')?.ok === true; },
    control: (on) => post(`remote/view/control?token=${j.token}`, { on }),
    input: (ev) => post(`remote/view/input?token=${j.token}`, { ev }),
    leave: async () => { lv.close(); await fetch(`${B}/api/remote/leave?token=${j.token}`, { method: 'POST' }); },
  };
  return v;
}
function startAgent(dir, extra = []) {
  const proc = spawn(EXE, ['--server', B, '--config', dir, '--quiet', ...extra], { stdio: 'ignore' });
  return { proc, kill: () => { try { proc.kill(); } catch {} } };
}

// 이 PC 의 입력 데스크톱을 열 수 있는지 (화면이 잠겨 있으면 못 연다 → 실제 입력은 어디에도 전달되지 않는다)
// 또는 이 시험을 돌리는 환경이 입력 주입을 막고 있을 때(샌드박스·권한). 아무 영향 없는 "키 떼기(미할당 키 0xE8)" 한 번을 SendInput 으로 시도해 본다.
const SEND = `Add-Type 'using System;using System.Runtime.InteropServices;public class S{[StructLayout(LayoutKind.Sequential)]public struct KI{public ushort vk;public ushort scan;public uint flags;public uint time;public IntPtr extra;}[StructLayout(LayoutKind.Explicit,Size=40)]public struct IN{[FieldOffset(0)]public uint type;[FieldOffset(8)]public KI ki;}[DllImport("user32.dll")]public static extern uint SendInput(uint n,IN[] i,int size);[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int k);public static string Try(){IN[] a=new IN[1];a[0].type=1;a[0].ki.vk=0x87;a[0].ki.flags=0;uint r=SendInput(1,a,Marshal.SizeOf(typeof(IN)));System.Threading.Thread.Sleep(80);bool d=(GetAsyncKeyState(0x87)&0x8000)!=0;a[0].ki.flags=2;SendInput(1,a,Marshal.SizeOf(typeof(IN)));return (r==1&&d)?"1":"0";}}'; [S]::Try()`;
const canInject = () => ps(`${NATIVE} if([N]::OpenInputDesktop(0,$false,0x100) -eq [IntPtr]::Zero){'locked'}else{ ${SEND} }`) === '1';
const screenSize = () => { const o = ps(`${NATIVE} "$([N]::GetSystemMetrics(0)),$([N]::GetSystemMetrics(1))"`).split(',').map(Number); return { w: o[0], h: o[1] }; };

// ═══ 1부: 입력을 "표적 파일"(--input-sink)에 기록하는 모드 — 화면이 잠겨 있어도 전체 경로(보는 화면 → 서버 → 에이전트 → 변환)를 확인 ═══
async function part1() {
  console.log('── 1부: 전체 경로 (에이전트가 실제 입력 대신 파일에 기록) ──');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ctl-'));
  const sink = path.join(dir, 'sink.log');
  const sinkLines = () => (fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean) : []);
  const wait = async (pred, ms = 3000) => { for (let i = 0; i < ms / 100; i++) { if (pred(sinkLines())) return true; await sleep(100); } return false; };
  const { w: sw, h: sh } = screenSize();
  const px = (r) => Math.round(r * (sw - 1)), py = (r) => Math.round(r * (sh - 1));
  const near = (line, x, y) => { const m = /^move (\d+) (\d+)$/.exec(line || ''); return !!m && Math.abs(+m[1] - x) <= 1 && Math.abs(+m[2] - y) <= 1; };
  let agent, v;
  try {
    // 처음에는 조종이 꺼져 있다 (기본값 = 보기만)
    const pair = await post('pair/start', {});
    agent = startAgent(dir, ['--code', pair.code, '--set-pin', PIN, '--input-sink', sink]);
    await sleep(3000);
    v = await viewer(pair.key);
    ok(await v.login(), 'PIN 통과');
    ok(v.lv.last('control')?.allowed === false, '에이전트를 처음 켜면 조종 허용이 꺼져 있음 (기본값)');
    ok((await v.control(true)).status === 409, '허용 전에는 조종 켜기가 거절됨 (409)');
    ok(!fs.existsSync(path.join(dir, 'control.on')), '허용 설정 파일이 없음');
    await v.leave(); agent.kill(); await sleep(1500);

    // --allow-control 로 켜면 설정이 저장되어, 다음에는 옵션 없이도 허용 상태
    agent = startAgent(dir, ['--allow-control', '--input-sink', sink]); await sleep(2500);
    ok(fs.existsSync(path.join(dir, 'control.on')), '--allow-control 이 허용 상태를 파일로 저장');
    agent.kill(); await sleep(1500);
    agent = startAgent(dir, ['--input-sink', sink]); await sleep(3000);
    v = await viewer(pair.key);
    ok(await v.login(), '다시 켠 에이전트에 PIN 통과');
    ok(v.lv.last('control')?.allowed === true, '옵션 없이 다시 켜도 허용 상태가 유지됨');

    // 켜기 전 입력은 에이전트에 닿지 않는다
    await v.input([{ t: 'm', x: 0.4, y: 0.4 }]); await sleep(300);
    ok(sinkLines().length === 0, '조종을 켜기 전에 보낸 입력은 에이전트에 닿지 않음');

    // 조종 켜기 + 띠 문구
    ok(/원격 접속 중/.test(bannerText()), `조종 전 띠 문구: "${bannerText()}"`);
    const on = await v.control(true);
    ok(on.status === 200 && on.on === true, '조종 켜기 성공');
    await sleep(1500);
    ok(bannerText().includes('원격 조종 중'), `조종 중에는 띠 문구가 바뀜: "${bannerText()}"`);

    // 마우스
    await v.input([{ t: 'm', x: 0.5, y: 0.5 }]);
    ok(await wait((l) => near(l[0], px(0.5), py(0.5))), `이동 → 화면 비율이 실제 픽셀로 변환 (${sinkLines()[0]}, 화면 ${sw}x${sh})`);
    let n = sinkLines().length;
    await v.input([{ t: 'd', x: 0.25, y: 0.75, b: 0 }, { t: 'u', x: 0.25, y: 0.75, b: 0 }]);
    ok(await wait((l) => l.length >= n + 4) && near(sinkLines()[n], px(0.25), py(0.75)) && sinkLines()[n + 1] === 'mouse 2 0' && sinkLines()[n + 2].startsWith('move') && sinkLines()[n + 3] === 'mouse 4 0', '왼쪽 클릭 → 좌표로 이동 후 LEFTDOWN(2)/LEFTUP(4)');
    n = sinkLines().length;
    await v.input([{ t: 'd', x: 0.5, y: 0.5, b: 2 }, { t: 'u', x: 0.5, y: 0.5, b: 2 }, { t: 'd', x: 0.5, y: 0.5, b: 1 }, { t: 'u', x: 0.5, y: 0.5, b: 1 }]);
    await wait((l) => l.length >= n + 8);
    const mouse = sinkLines().slice(n).filter((x) => x.startsWith('mouse'));
    ok(mouse.join(',') === 'mouse 8 0,mouse 16 0,mouse 32 0,mouse 64 0', `오른쪽(8/16)·가운데(32/64) 버튼 번호가 브라우저 → Windows 로 올바르게 바뀜 (${mouse.join(',')})`);
    n = sinkLines().length;
    await v.input([{ t: 'w', dx: 0, dy: 100 }, { t: 'w', dx: 0, dy: -100 }, { t: 'w', dx: 100, dy: 0 }]);
    await wait((l) => l.length >= n + 3);
    ok(sinkLines().slice(n).join(',') === 'mouse 2048 -120,mouse 2048 120,mouse 4096 120', `휠: 아래로 100 → -120, 위로 → +120, 가로 → HWHEEL (${sinkLines().slice(n).join(',')})`);

    // 키보드
    n = sinkLines().length;
    await v.input([{ t: 'k', vk: 0x37, d: 1, e: 0 }, { t: 'k', vk: 0x37, d: 0, e: 0 }, { t: 'k', vk: 37, d: 1, e: 1 }, { t: 'k', vk: 37, d: 0, e: 1 }]);
    await wait((l) => l.length >= n + 4);
    ok(sinkLines().slice(n).join(',') === 'key 55 0,key 55 2,key 37 1,key 37 3', `키 누름/뗌/확장키(방향키) 플래그가 맞음 (${sinkLines().slice(n).join(',')})`);

    // 눌린 채로 남은 키는 조종을 끄면 모두 떼어진다
    n = sinkLines().length;
    await v.input([{ t: 'k', vk: 0x32, d: 1, e: 0 }, { t: 'd', x: 0.5, y: 0.5, b: 0 }]); await sleep(300);
    const off = await v.control(false);
    ok(off.status === 200 && off.on === false, '보는 사람이 조종을 끔');
    ok(await wait((l) => l.slice(n).includes('key 50 2') && l.slice(n).includes('mouse 4 0'), 4000), '조종이 꺼지자 눌려 있던 키·마우스 버튼이 자동으로 떼어짐');
    await sleep(1500);
    ok(/원격 접속 중/.test(bannerText()), `조종이 끝나면 띠 문구가 "접속 중"으로 돌아옴: "${bannerText()}"`);
    n = sinkLines().length;
    const rej = await v.input([{ t: 'm', x: 0.1, y: 0.1 }]); await sleep(300);
    ok(rej.status === 409 && sinkLines().length === n, '끈 뒤의 입력은 거절되고 에이전트에도 닿지 않음');

    // 즉시 중지: panic.now 파일 (Ctrl+Alt+F12 와 트레이 메뉴는 같은 Panic 함수)
    await v.control(true); await sleep(500);
    n = sinkLines().length;
    await v.input([{ t: 'k', vk: 0x32, d: 1, e: 0 }]); await sleep(300);
    fs.writeFileSync(path.join(dir, 'panic.now'), '');
    for (let i = 0; i < 40 && v.lv.last('control')?.allowed !== false; i++) await sleep(100);
    ok(v.lv.last('control')?.allowed === false && v.lv.last('control')?.on === false, 'panic.now 한 번에 보는 쪽이 "조종 불가"로 바뀜');
    ok(sinkLines().slice(n).includes('key 50 2'), '즉시 중지가 눌려 있던 키를 모두 뗌');
    ok(!fs.existsSync(path.join(dir, 'control.on')) && !fs.existsSync(path.join(dir, 'panic.now')), '허용 설정이 꺼져 파일이 사라지고, 신호 파일도 지워짐');
    ok((await v.control(true)).status === 409, '즉시 중지 뒤 다시 조종 켜기는 거절됨');
    n = sinkLines().length;
    ok((await v.input([{ t: 'm', x: 0.2, y: 0.2 }])).status === 409 && sinkLines().length === n, '입력도 거절됨');

    // 접속 기록
    const accessLog = fs.readFileSync(path.join(dir, 'access.log'), 'utf8');
    ok(/조종 시작/.test(accessLog) && /조종 끝/.test(accessLog), 'access.log 에 조종 시작/끝이 기록됨');
    ok(/조종 즉시 중지 \(panic\.now/.test(accessLog) && /조종 허용을 껐어요/.test(accessLog), 'access.log 에 즉시 중지가 기록됨');
    ok(!accessLog.includes(PIN) && !accessLog.includes(pair.key) && !/key 55|0x37/.test(accessLog), 'access.log 에 키 입력·PIN·열쇠는 없음');
  } catch (e) { console.log('ERROR', e); }
  try { await v?.leave(); } catch {}
  agent?.kill();
}

// ═══ 2부: 진짜 입력 (화면이 풀려 있을 때만) — 표적 창에 실제 클릭·키가 들어가는지 ═══
async function part2() {
  console.log('── 2부: 실제 입력 (표적 창) ──');
  if (!canInject()) { console.log('SKIP 이 환경에서는 실제 입력을 넣을 수 없어요 (화면 잠금, 또는 시험을 돌리는 프로그램이 입력 주입을 막음 — SendInput 접근 거부). 일반 터미널에서 화면을 풀어 둔 채 다시 돌리면 이 부분도 확인돼요'); return 'skipped'; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ctl-'));
  const out = path.join(os.tmpdir(), 'tt-target-' + Date.now() + '.log');
  const before = cursor();
  let agent, target, v;
  try {
    const pair = await post('pair/start', {});
    agent = startAgent(dir, ['--code', pair.code, '--set-pin', PIN, '--allow-control']); await sleep(3000);
    v = await viewer(pair.key);
    ok(await v.login(), 'PIN 통과');
    target = spawn(PS, ['-NoProfile', '-STA', '-File', TARGET, out], { stdio: 'ignore' });
    let geo = null;
    for (let i = 0; i < 60 && !geo; i++) { await sleep(250); try { geo = JSON.parse(fs.readFileSync(out + '.json', 'utf8')); } catch {} }
    ok(!!geo, `표적 창이 떴음 (${geo ? geo.sw + 'x' + geo.sh : '—'})`);
    if (!geo) throw new Error('표적 창 없음');
    const rx = (p) => p / (geo.sw - 1), ry = (p) => p / (geo.sh - 1);
    const log = () => fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean);
    const waitLog = async (pred, ms = 3000) => { for (let i = 0; i < ms / 100; i++) { if (pred(log())) return true; await sleep(100); } return false; };
    ok((await v.control(true)).on === true, '조종 켜기'); await sleep(800);

    await v.input([{ t: 'm', x: 0.5, y: 0.5 }]); await sleep(300);
    const c1 = cursor();
    ok(Math.abs(c1.x - Math.round(0.5 * (geo.sw - 1))) <= 1 && Math.abs(c1.y - Math.round(0.5 * (geo.sh - 1))) <= 1, `커서가 화면 비율 좌표로 이동 (${c1.x},${c1.y})`);
    const b = { x: rx(geo.btnX), y: ry(geo.btnY) };
    await v.input([{ t: 'm', ...b }, { t: 'd', ...b, b: 0 }, { t: 'u', ...b, b: 0 }]);
    ok(await waitLog((l) => l.includes('click')), '왼쪽 클릭이 표적 버튼에 도달');
    await v.input([{ t: 'd', ...b, b: 2 }, { t: 'u', ...b, b: 2 }]);
    ok(await waitLog((l) => l.includes('right')), '오른쪽 클릭이 도달');
    await v.input([{ t: 'k', vk: 27, d: 1, e: 0 }, { t: 'k', vk: 27, d: 0, e: 0 }]); await sleep(200); // 컨텍스트 메뉴 닫기
    await v.input([{ t: 'd', ...b, b: 0 }, { t: 'u', ...b, b: 0 }, { t: 'd', ...b, b: 0 }, { t: 'u', ...b, b: 0 }]);
    ok(await waitLog((l) => l.includes('double')), '더블클릭이 도달');
    await v.input([{ t: 'w', dx: 0, dy: 100 }]);
    ok(await waitLog((l) => l.includes('wheel:-120')), '휠이 도달 (-120)');
    const t = { x: rx(geo.tbX), y: ry(geo.tbY) };
    await v.input([{ t: 'm', ...t }, { t: 'd', ...t, b: 0 }, { t: 'u', ...t, b: 0 }]); await sleep(300);
    const key = (vk) => [{ t: 'k', vk, d: 1, e: 0 }, { t: 'k', vk, d: 0, e: 0 }];
    await v.input([...key(0x37), ...key(0x33), ...key(0x39), ...key(0x30)]);
    ok(await waitLog((l) => l.includes('text:7390')), '키보드 입력 "7390" 이 글상자에 들어감 (숫자만 — 한/영 IME 영향 없음)');
    await v.input(key(8));
    ok(await waitLog((l) => l.includes('text:739')), 'Backspace 동작');
    await v.input([{ t: 'k', vk: 0x32, d: 1, e: 0 }]); await sleep(300);
    ok(keyIsDown(0x32), '키를 누른 채(떼지 않음)로 둠');
    await v.control(false); await sleep(1800);
    ok(!keyIsDown(0x32), '조종을 끄자 눌려 있던 실제 키가 떼어짐');
    await v.control(true); await sleep(500);
    await v.input([{ t: 'k', vk: 0x32, d: 1, e: 0 }]); await sleep(300);
    panicHotkey(); await sleep(1500);
    ok(v.lv.last('control')?.allowed === false, '실제 단축키 Ctrl+Alt+F12 한 번에 조종이 꺼지고 허용이 해제됨');
    ok(!keyIsDown(0x32), '단축키가 눌려 있던 키도 모두 뗌');
  } catch (e) { console.log('ERROR', e); }
  try { await v?.leave(); } catch {}
  agent?.kill(); try { target?.kill(); } catch {}
  ps('Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "tt-control-target" } | Stop-Process -Force -Confirm:$false');
  setCursor(before.x, before.y);
  const after = cursor();
  ok(Math.abs(after.x - before.x) <= 1 && Math.abs(after.y - before.y) <= 1, '시험이 끝나고 커서를 원래 자리로 되돌림');
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('FAIL 에이전트가 빌드되어 있지 않아요 (agent\\build-agent.cmd)'); process.exit(1); }
  await part1();
  await part2();
  process.exit(0);
})();
