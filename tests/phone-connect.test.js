// "휴대폰 원격 연결하기" 시험 (이슈 #48): 서버가 주는 APK + 폰 브라우저(안드로이드)에서 누르는 버튼 화면. 서버를 띄우고 Edge(원격 디버깅 9333)를 띄운 뒤
//   node tests/phone-connect.test.js http://localhost:8787
// (APK 는 android\build-release.cmd 로 만들어 public/download/ 에 있어야 한다. 서명 검증은 Android SDK 의 apksigner 가 있을 때만)
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const B = process.argv[2], D = 'http://127.0.0.1:9333';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));
const APK_FILE = path.join(__dirname, '..', 'public', 'download', 'text-tunnel-phone.apk');
const PKG = 'dev.esstional.texttunnel.phone';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, evaluate: async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value, close: () => ws.close() };
}
async function fakeAgent(key, platform) { // 서버에 입장만 하는 가짜 에이전트 (상태 표시 시험용)
  const j = await post('remote/agent/join', { key, name: platform === 'android' ? '내 폰' : '노트북', ...(platform ? { platform } : {}) });
  const ac = new AbortController();
  fetch(`${B}/api/remote/agent/events?token=${j.token}`, { signal: ac.signal }).then(async (r) => { for await (const _ of r.body); }).catch(() => {});
  return { stop: async () => { ac.abort(); await fetch(`${B}/api/remote/leave?token=${j.token}`, { method: 'POST' }); } };
}

(async () => {
  // ── 1) 서버가 주는 APK ──────────────────────────
  const r = await fetch(`${B}/download/text-tunnel-phone.apk`);
  const buf = Buffer.from(await r.arrayBuffer());
  const disk = fs.existsSync(APK_FILE) ? fs.readFileSync(APK_FILE) : null;
  ok(r.status === 200 && r.headers.get('content-type') === 'application/vnd.android.package-archive', `APK 를 내려받을 수 있고 형식이 안드로이드 패키지 (${r.status}, ${r.headers.get('content-type')})`);
  ok(/attachment; filename="text-tunnel-phone\.apk"/.test(r.headers.get('content-disposition') || '') && Number(r.headers.get('content-length')) === buf.length, '열지 않고 내려받게 하는 헤더 + 길이가 맞음');
  ok(buf[0] === 0x50 && buf[1] === 0x4b && !!disk && buf.equals(disk), `받은 파일이 저장소의 APK 와 같음 (${Math.round(buf.length / 1024)}KB, ZIP 형식)`);
  ok(buf.includes(Buffer.from('AndroidManifest.xml')) && buf.includes(Buffer.from('classes.dex')), 'APK 안에 AndroidManifest.xml 과 classes.dex 가 있음');
  ok(buf.includes(Buffer.from('APK Sig Block 42')), 'APK 서명 블록이 있음 (서명되어 있어 업데이트 가능)');
  const SDK = process.env.ANDROID_HOME || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  const bt = path.join(SDK, 'build-tools');
  const signer = fs.existsSync(bt) ? fs.readdirSync(bt).sort().reverse().map((v) => path.join(bt, v, 'apksigner.bat')).find((p) => fs.existsSync(p)) : null;
  if (signer) {
    let out = '';
    try { out = execFileSync('C:\\Windows\\System32\\cmd.exe', ['/c', signer, 'verify', '--print-certs', APK_FILE], { encoding: 'utf8', env: { ...process.env, PATH: 'C:\\Windows\\System32;C:\\Windows;' + process.env.PATH, JAVA_HOME: process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot' } }); } catch (e) { out = 'ERR ' + (e.stdout || e.message); }
    // 검증에 실패하면 apksigner 가 오류로 끝나 ERR 로 잡힌다
    ok(!/^ERR/.test(out) && /certificate DN: CN=Text Tunnel/.test(out) && !/DOES NOT VERIFY/.test(out), 'apksigner 검증 통과 (서명자 CN=Text Tunnel)');
  } else console.log('SKIP apksigner 가 없어 서명 검증은 건너뜀');

  // ── 2) 폰 브라우저 화면 ─────────────────────────
  const key = crypto.randomBytes(32).toString('base64url');
  let ag;
  try {
    const t = await (await fetch(`${D}/json/new?about:blank`, { method: 'PUT' })).json();
    const tab = await cdp(t.webSocketDebuggerUrl);
    await tab.call('Page.enable');
    const open = async (ua, mobile) => {
      await tab.call('Emulation.setUserAgentOverride', { userAgent: ua });
      await tab.call('Emulation.setDeviceMetricsOverride', mobile ? { width: 400, height: 820, deviceScaleFactor: 2, mobile: true } : { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false });
      await tab.call('Page.navigate', { url: `${B}/` }); await sleep(700);
      await tab.evaluate(`localStorage.setItem('tt.key', ${JSON.stringify(key)}); localStorage.setItem('tt.device', 'pc-${ua.length}'); localStorage.setItem('tt.name', '기기'); 1`);
      await tab.call('Page.reload'); await sleep(2500);
      await tab.evaluate(`enterChat(); 1`); await sleep(900);
      await tab.evaluate(`document.getElementById('menuBtn').click(); document.getElementById('mPhone').click(); 1`); await sleep(1500);
    };
    const q = (js) => tab.evaluate(js);
    const text = (id) => q(`document.getElementById('${id}').textContent`);
    const waitText = async (id, re, ms = 6000) => { for (let i = 0; i < ms / 100; i++) { if (re.test(await text(id))) return true; await sleep(100); } return false; };

    // 안드로이드 폰
    await open(ANDROID_UA, true);
    ok(await q(`!document.getElementById('phoneScreen').hidden && document.getElementById('chat').hidden`), '폰 메뉴 → "휴대폰 원격 연결하기" 화면으로 전환됨');
    const href = await q(`document.getElementById('phoneConnect').getAttribute('href')`);
    const m = /^intent:\/\/connect\?code=([A-Z0-9]{6})&server=([^#]+)#Intent;scheme=texttunnel;package=([^;]+);S\.browser_fallback_url=([^;]+);end$/.exec(href || '');
    ok(!!m && m[3] === PKG, `버튼은 안드로이드 인텐트 링크: ${href && href.slice(0, 70)}…`);
    ok(!!m && decodeURIComponent(m[2]) === B && decodeURIComponent(m[4]) === `${B}/download/text-tunnel-phone.apk`, '링크에 이 서버 주소가 실리고, 앱이 없으면 가는 폴백 주소가 APK 다운로드 주소');
    ok(await q(`!document.getElementById('phoneConnect').hidden`), '안드로이드에서는 연결 버튼이 보임');
    const claimed = await post('pair/claim', { code: m?.[1] });
    ok(claimed.key === key, '링크의 코드가 이 폰의 짝 열쇠로 연결되는 유효한 1회용 코드');
    ok((await q(`document.getElementById('phoneOpen').getAttribute('href')`)).startsWith('texttunnel://connect?code=') && (await q(`document.getElementById('phoneDownload').getAttribute('href')`)) === '/download/text-tunnel-phone.apk', '"앱 열기"(직접 링크)와 "앱만 받기" 보조 링크도 있음');
    ok(await waitText('phoneStatus', /아직 폰이 연결되지 않았어요/), `폰이 아직 연결 안 됐을 때 상태: "${await text('phoneStatus')}"`);
    ag = await fakeAgent(key, 'android');
    ok(await waitText('phoneStatus', /폰이 연결됐어요.*원격 화면 보기/), `폰 앱이 연결되면 실시간으로 "폰이 연결됐어요": "${await text('phoneStatus')}"`);
    ok(await q(`document.getElementById('phoneDot').classList.contains('on')`), '상태 점이 켜짐 색');
    await ag.stop(); ag = null;
    ok(await waitText('phoneStatus', /아직 폰이 연결되지 않았어요/, 8000), '연결이 끊기면 다시 "아직 연결되지 않았어요"');
    ag = await fakeAgent(key, undefined);
    ok(await waitText('phoneStatus', /PC\) 에이전트가 연결돼 있어요/), `PC 에이전트만 연결돼 있으면 폰이 아직이라고 구분해 알려 줌: "${await text('phoneStatus')}"`);
    await ag.stop(); ag = null;
    await q(`document.getElementById('phoneBack').click(); 1`); await sleep(500);
    ok(await q(`!document.getElementById('chat').hidden`), '뒤로 가면 메신저로 돌아옴');

    // PC
    await open('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', false);
    ok(await q(`document.getElementById('phoneConnect').hidden`) && (await text('phoneNote')).includes('안드로이드 폰'), `PC 에서는 버튼 대신 "연결할 폰에서 눌러 주세요" 안내: "${await text('phoneNote')}"`);
    await q(`document.getElementById('phoneBack').click(); 1`); await sleep(400);
    // 아이폰
    await open(IPHONE_UA, true);
    ok(await q(`document.getElementById('phoneConnect').hidden`) && (await text('phoneNote')).includes('아이폰은 지원하지 않아요'), `아이폰에서는 지원하지 않는다고 안내: "${await text('phoneNote')}"`);
    tab.close();
  } catch (e) { console.log('ERROR', e); }
  try { await ag?.stop(); } catch {}
  process.exit(0);
})();
