// 폰 에이전트(안드로이드 앱) 실제 시험 (이슈 #46) — 가상 폰(에뮬레이터)에 앱을 설치해 서버·보는 쪽과 끝까지 확인한다. Windows + Android SDK 필요.
//   1) android\gradlew assembleDebug 로 앱을 빌드  2) 에뮬레이터를 띄움 (README 의 "폰 원격 시험")  3) 서버를 띄움
//   node tests/phone-agent.test.js http://localhost:8787
// 에뮬레이터는 호스트 PC 를 10.0.2.2 로 본다. 실제 폰이 연결돼 있으면 그 폰을 쓰지 않도록 에뮬레이터(emulator-*)만 고른다.
// ⚠ 이 시험은 에뮬레이터의 앱 설정을 바꾸고(PIN·접근성·조종 허용) 화면에 터치를 넣는다 — 에뮬레이터 전용.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2];
const PORT = new URL(B).port || '80';
const SDK = process.env.ANDROID_HOME || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
const APK = path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PKG = 'dev.esstional.texttunnel.phone';
const PIN = '482915';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));

let SERIAL = null;
const adb = (...args) => execFileSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const sh = (cmd) => adb('shell', cmd);
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
function jpegSize(b) {
  let i = 2;
  while (i < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + b.readUInt16BE(i + 2); }
  return null;
}
// 화면의 UI 요소 찾기 (uiautomator dump): content-desc 또는 text 로
function findNode(attr, value) {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
  const re = new RegExp(`<node[^>]*${attr}="${value}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
  const m = re.exec(xml);
  if (!m) return null;
  const [l, t, r, b] = m.slice(1).map(Number);
  const text = /text="([^"]*)"/.exec(m[0])?.[1];
  return { x: (l + r) / 2, y: (t + b) / 2, text };
}
const nodeText = (desc) => { const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty'); const m = new RegExp(`<node[^>]*text="([^"]*)"[^>]*content-desc="${desc}"`).exec(xml) || new RegExp(`<node[^>]*content-desc="${desc}"[^>]*text="([^"]*)"`).exec(xml); return m?.[1]; };
const logcat = (tag) => adb('logcat', '-d', '-s', `${tag}:I`);

(async () => {
  if (!fs.existsSync(ADB)) { console.log('SKIP Android SDK(adb)가 없어요 — 이 시험은 Android SDK 가 있는 Windows PC 에서만 돌아요'); process.exit(0); }
  const devices = execFileSync(ADB, ['devices'], { encoding: 'utf8' }).split('\n').filter((l) => /^emulator-\d+\s+device/.test(l));
  if (!devices.length) { console.log('SKIP 켜져 있는 에뮬레이터가 없어요 (README 의 "폰 원격 시험" 참고). 실제 폰에는 이 시험을 돌리지 않아요'); process.exit(0); }
  SERIAL = devices[0].split(/\s+/)[0];
  if (!fs.existsSync(APK)) { console.log('FAIL 앱이 빌드되어 있지 않아요 (android\\gradlew assembleDebug)'); process.exit(1); }

  let viewer, lv;
  try {
    // ── 설치·설정 ──
    adb('install', '-r', '-g', APK); // -g: 알림 등 권한을 미리 허용
    sh(`am force-stop ${PKG}`);
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh(`appops set ${PKG} PROJECT_MEDIA allow`);
    sh(`settings put secure enabled_accessibility_services ${PKG}/${PKG}.TunnelAccessibilityService`);
    sh('settings put secure accessibility_enabled 1');
    sh('logcat -c');
    const size = /(\d+)x(\d+)/.exec(sh('wm size'));
    const SW = Number(size[1]), SH = Number(size[2]);
    ok(SW > 0 && SH > 0, `가상 폰 화면 크기 ${SW}x${SH}`);

    // ── 짝 맺기 + PIN + (조종은 아직 허용 안 함) ──
    const { key, code } = await post('pair/start', {});
    sh(`am start -n ${PKG}/.MainActivity --es server http://10.0.2.2:${PORT} --es pin ${PIN} --es code ${code} --ez control false`);
    await sleep(3500);
    const joined = await post('pair/start', { key }); // 열쇠 확인용(방이 유효)
    ok(!!joined.code, '앱이 짝 코드로 같은 짝 열쇠를 받음 (코드 사용 후에도 같은 열쇠의 방이 유효)');

    // ── 화면 공유 시작 ──
    sh(`am start -n ${PKG}/.MainActivity --ez share true`);
    let agentOnline = false;
    const vj = await post('remote/view/join', { key });
    viewer = vj; lv = listen('view/events', vj.token);
    for (let i = 0; i < 60 && !agentOnline; i++) { await sleep(500); agentOnline = lv.last('agent')?.online === true; if (!agentOnline && i === 10) { const n = findNode('text', '지금 시작|시작|Start now'); if (n) sh(`input tap ${Math.round(n.x)} ${Math.round(n.y)}`); } }
    ok(agentOnline && lv.last('agent')?.platform === 'android', `폰 에이전트가 서버에 입장하고 platform 이 android: ${JSON.stringify(lv.last('agent'))}`);

    // ── PIN 전에는 아무것도 안 온다 ──
    await sleep(1500);
    ok(lv.all('frame').length === 0, '인증 전에는 화면이 오지 않음 (보는 사람으로 세지 않아 캡처도 안 함)');
    const wrong = await post(`remote/view/auth?token=${vj.token}`, { pin: '111111' });
    await sleep(2500);
    ok(lv.last('auth')?.ok === false && lv.last('auth')?.left === 4, `틀린 PIN 은 폰이 직접 판정해 남은 횟수를 알려 줌: ${JSON.stringify(lv.last('auth'))}`);
    await post(`remote/view/auth?token=${vj.token}`, { pin: PIN });
    for (let i = 0; i < 30 && lv.last('auth')?.ok !== true; i++) await sleep(300);
    ok(lv.last('auth')?.ok === true, '맞는 PIN 은 통과');

    // ── 화면이 온다 ──
    for (let i = 0; i < 40 && !lv.last('frame'); i++) await sleep(300);
    const f = lv.last('frame');
    ok(!!f && f.w <= 720 && f.h > f.w, `폰 화면이 세로로 전달됨 (${f?.w}x${f?.h})`);
    const img = await fetch(`${B}/api/remote/frame?token=${vj.token}`);
    const buf = Buffer.from(await img.arrayBuffer());
    const js = jpegSize(buf);
    ok(buf[0] === 0xff && buf[1] === 0xd8 && js && js.w === f.w && js.h === f.h, `받은 것이 올바른 JPEG 이고 크기가 알림과 같음 (${js?.w}x${js?.h}, ${Math.round(buf.length / 1024)}KB)`);
    ok(Math.abs(js.h / js.w - SH / SW) < 0.02, `화면 비율이 실제 폰과 같음 (${(js.h / js.w).toFixed(3)} vs ${(SH / SW).toFixed(3)})`);

    // ── 조종은 별도 허용 ──
    const refused = await post(`remote/view/control?token=${vj.token}`, { on: true });
    ok(refused.status === 409, '폰 주인이 조종 허용을 켜지 않았으면 조종 켜기 거절 (409)');
    sh(`am start -n ${PKG}/.MainActivity --ez control true`);
    for (let i = 0; i < 30 && lv.last('control')?.allowed !== true; i++) await sleep(400);
    ok(lv.last('control')?.allowed === true, '조종을 허용하면(접근성 서비스가 켜져 있을 때) 보는 쪽에 "조종 가능" 알림');
    ok((await post(`remote/view/control?token=${vj.token}`, { on: true })).on === true, '조종 켜기 성공');
    await sleep(600);
    const input = (ev) => post(`remote/view/input?token=${vj.token}`, { ev });
    const ratio = (n) => ({ x: n.x / (SW - 1), y: n.y / (SH - 1) });

    // ── 탭 ──
    sh(`am start -n ${PKG}/.MainActivity`); await sleep(1200);
    const btn = findNode('content-desc', 'tap-test');
    ok(!!btn, `시험용 단추를 화면에서 찾음 (${btn && Math.round(btn.x) + ',' + Math.round(btn.y)})`);
    const r = ratio(btn);
    sh('logcat -c');
    await input([{ t: 'm', ...r }, { t: 'd', ...r, b: 0 }, { t: 'u', ...r, b: 0 }]);
    await sleep(1200);
    ok(/tap count=1/.test(logcat('TT_TEST')), `PC 에서 누른 마우스 클릭이 폰에서 실제 탭이 되어 단추가 눌림: ${(/tap count=\d+/.exec(logcat('TT_TEST')) || [])[0]}`);
    ok(/tap \d+,\d+/.test(logcat('TT_GESTURE')), '접근성 서비스가 탭 동작을 주입함');

    // ── 길게 누르기 ──
    sh('logcat -c');
    await input([{ t: 'd', ...r, b: 0 }]); await sleep(900); await input([{ t: 'u', ...r, b: 0 }]);
    await sleep(1500);
    ok(/long press/.test(logcat('TT_TEST')), '0.5초 넘게 누르면 길게 누르기로 전달됨');

    // ── 글자 입력 (한글 포함) ──
    const field = findNode('content-desc', 'text-test');
    const fr = ratio(field);
    await input([{ t: 'm', ...fr }, { t: 'd', ...fr, b: 0 }, { t: 'u', ...fr, b: 0 }]); await sleep(1200);
    await input([{ t: 's', s: '안녕 hello 123' }]); await sleep(1200);
    ok(nodeText('text-test') === '안녕 hello 123', `"글자 보내기"가 한글 포함 그대로 입력칸에 들어감: "${nodeText('text-test')}"`);
    await input([{ t: 'k', vk: 65, d: 1, e: 0, ch: 'A' }, { t: 'k', vk: 8, d: 1, e: 0 }, { t: 'k', vk: 8, d: 1, e: 0 }, { t: 'k', vk: 66, d: 1, e: 0, ch: '!' }]); await sleep(1200);
    ok(nodeText('text-test') === '안녕 hello 12!', `키보드 글자는 커서 위치에 들어가고 Backspace 로 지워짐: "${nodeText('text-test')}"`);

    // ── 스와이프·스크롤 ──
    sh('logcat -c');
    await input([{ t: 'm', x: 0.5, y: 0.8 }, { t: 'd', x: 0.5, y: 0.8, b: 0 }, { t: 'm', x: 0.5, y: 0.6 }, { t: 'm', x: 0.5, y: 0.4 }, { t: 'u', x: 0.5, y: 0.3, b: 0 }]);
    await sleep(1000);
    ok(/swipe \d+,\d+ -> \d+,\d+/.test(logcat('TT_GESTURE')), `드래그는 스와이프로 전달됨: ${(/swipe [^\n]*/.exec(logcat('TT_GESTURE')) || [])[0]?.slice(0, 50)}`);
    sh('logcat -c');
    await input([{ t: 'w', dx: 0, dy: 100 }]); await sleep(900);
    ok(/scroll dx=0 dy=100/.test(logcat('TT_GESTURE')), '휠은 화면 스크롤로 전달됨');

    // ── 뒤로·홈 (이동 동작) ──
    await input([{ t: 'n', a: 'home' }]); await sleep(1500);
    const focus = sh('dumpsys window | grep mCurrentFocus');
    ok(!focus.includes(PKG), `홈 동작: 앱 밖(홈 화면)으로 나감 (${focus.trim().slice(0, 90)})`);
    sh(`am start -n ${PKG}/.MainActivity`); await sleep(1000);
    await input([{ t: 'd', x: 0.5, y: 0.5, b: 2 }, { t: 'u', x: 0.5, y: 0.5, b: 2 }]); await sleep(1200);
    ok(!sh('dumpsys window | grep mCurrentFocus').includes(`${PKG}/${PKG}.MainActivity`), '마우스 오른쪽 버튼은 뒤로 가기');

    // ── 조종 끄기: 입력이 더는 들어가지 않는다 ──
    sh(`am start -n ${PKG}/.MainActivity`); await sleep(1200);
    sh('logcat -c');
    sh(`am start -n ${PKG}/.MainActivity --ez control false`);
    for (let i = 0; i < 30 && lv.last('control')?.allowed !== false; i++) await sleep(400);
    ok(lv.last('control')?.allowed === false && lv.last('control')?.on === false, '폰에서 조종 허용을 끄면 보는 쪽 조종도 즉시 꺼짐');
    ok((await input([{ t: 'm', ...r }, { t: 'd', ...r, b: 0 }, { t: 'u', ...r, b: 0 }])).status === 409, '끈 뒤의 입력은 거절됨 (409)');
    await sleep(800);
    ok(!/tap count/.test(logcat('TT_TEST')), '폰에는 아무 입력도 들어가지 않음');

    // ── 알림·기록 ──
    const notif = sh('dumpsys notification --noredact | grep -A2 "pkg=' + PKG + '" | head -12');
    ok(/원격 허용 중|화면 공유/.test(sh('dumpsys notification --noredact')), '화면 공유 중에는 알림이 떠 있음 (포그라운드 서비스)');
    const log = sh(`run-as ${PKG} cat files/access.log`);
    ok(/접속 성공/.test(log) && /접속 실패/.test(log) && /조종 시작/.test(log) && /조종 끝/.test(log), '폰의 access.log 에 접속 성공·실패, 조종 시작/끝이 기록됨');
    ok(!log.includes(PIN) && !log.includes(key) && !/안녕|hello/.test(log), 'access.log 에 PIN·열쇠·입력한 글자는 없음');

    // ── 중지 ──
    sh(`am startservice -n ${PKG}/.AgentService -a dev.esstional.texttunnel.phone.STOP`);
    for (let i = 0; i < 30 && lv.last('agent')?.online !== false; i++) await sleep(400);
    ok(lv.last('agent')?.online === false, '알림의 "중지"(서비스 중지)를 누르면 에이전트가 오프라인이 되고 화면 공유가 끝남');
  } catch (e) { console.log('ERROR', e.message); }
  try { lv?.close(); if (viewer) await fetch(`${B}/api/remote/leave?token=${viewer.token}`, { method: 'POST' }); } catch {}
  try { sh(`am force-stop ${PKG}`); sh('settings put secure enabled_accessibility_services ""'); } catch {}
  process.exit(0);
})();
