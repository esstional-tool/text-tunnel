// 휴대폰에서 원격 화면 보기 시험 (이슈 #44) — 휴대폰 모드(Edge 모바일 에뮬레이션) + 진짜 에이전트(합성 화면). Windows 전용.
//   1) agent\build-agent.cmd 로 빌드  2) Edge 를 --remote-debugging-port=9333 으로 띄움  3) 서버 띄움
//   node tests/remote-mobile.test.js http://localhost:8787
// 에이전트는 --fake-screen 으로 띄워 이 PC 의 화면 내용을 읽지 않는다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2], D = 'http://127.0.0.1:9333';
const EXE = path.join(__dirname, '..', 'agent', 'remote-agent.exe');
const PIN = '482915';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, evaluate: async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value, close: () => ws.close() };
}
// 화면 켜 두기(Wake Lock)를 가짜로: 요청·해제 횟수를 기록
const WAKE = `
  window.__wake = { req: 0, rel: 0 };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake.req++; return { release: async () => { window.__wake.rel++; }, addEventListener() {} }; } } });`;

(async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mobile-'));
  fs.writeFileSync(path.join(cfg, 'fake-screen.txt'), ['size 1280 720', 'rect 40 90 760 560 255 255 255', 'rect 840 90 400 260 255 229 0'].join('\n'));
  let agent;
  try {
    const { key } = await post('pair/start', {});
    const t = await (await fetch(`${D}/json/new?about:blank`, { method: 'PUT' })).json();
    const tab = await cdp(t.webSocketDebuggerUrl);
    await tab.call('Page.enable');
    await tab.call('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
    await tab.call('Emulation.setDeviceMetricsOverride', { width: 400, height: 820, deviceScaleFactor: 2, mobile: true });
    await tab.call('Page.addScriptToEvaluateOnNewDocument', { source: WAKE });
    await tab.call('Page.navigate', { url: `${B}/` }); await sleep(800);
    await tab.evaluate(`localStorage.setItem('tt.key', ${JSON.stringify(key)}); localStorage.setItem('tt.device', 'mobile-test'); localStorage.setItem('tt.name', '휴대폰'); 1`);
    await tab.call('Page.reload'); await sleep(2500);
    const q = (js) => tab.evaluate(js);
    const text = (id) => q(`document.getElementById('${id}').textContent`);
    const waitText = async (id, re, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (re.test(await text(id))) return true; await sleep(100); } return false; };
    ok(await q(`IS_MOBILE === true`), '휴대폰으로 인식됨 (모바일 에뮬레이션)');
    await q(`enterChat(); 1`); await sleep(1200); // 휴대폰은 설치 안내가 먼저 뜨므로 대화 화면으로 직접 들어감 (설치된 앱처럼)

    // 1) 메뉴에 "원격 화면 보기"가 있다 (이전에는 휴대폰에서 숨겨져 있었음)
    await q(`document.getElementById('menuBtn').click(); 1`); await sleep(400);
    ok(await q(`!document.getElementById('mRemote').hidden`), '휴대폰 메뉴에 "원격 화면 보기"가 보임');
    ok(await q(`document.getElementById('mHost').hidden`), '"이 PC 원격 허용 켜기"는 PC 전용이라 휴대폰에서는 계속 숨김');

    // 2) 에이전트를 켜 두고 들어가 PIN 입력
    const code = (await post('pair/start', { key })).code;
    agent = spawn(EXE, ['--server', B, '--config', cfg, '--code', code, '--set-pin', PIN, '--quiet', '--fake-screen', cfg], { stdio: 'ignore' });
    await sleep(3500);
    await q(`document.getElementById('mRemote').click(); 1`);
    ok(await waitText('remoteStatus', /PIN 을 입력하세요/, 8000), `에이전트가 켜져 있으면 PIN 입력 화면이 나옴: "${await text('remoteStatus')}"`);
    await q(`(() => { document.getElementById('pinInput').value = '${PIN}'; document.getElementById('pinForm').requestSubmit(); return 1; })()`);
    ok(await waitText('remoteStatus', /화면을 받는 중/, 8000), `PIN 을 넣으면 화면을 받음: "${await text('remoteStatus')}"`);
    await sleep(1200);
    ok((await q(`document.getElementById('remoteCanvas').width`)) === 1280, '캔버스가 원격 화면 크기(1280)로 바뀜');

    // 3) 휴대폰은 보기 전용 + 확대 단추 + 머리줄이 넘치지 않음
    ok(await q(`document.getElementById('remoteCtl').hidden`), '휴대폰에서는 "조종 켜기" 단추가 숨겨짐 (보기 전용)');
    ok(await q(`!document.getElementById('remoteZoom').hidden && document.getElementById('remoteZoom').textContent === '확대'`), '"확대" 단추가 보임');
    ok(await q(`document.documentElement.scrollWidth <= window.innerWidth + 1 && document.getElementById('remoteScreen').scrollWidth <= window.innerWidth + 1`), '좁은 화면에서도 머리줄이 넘치지 않음 (가로 스크롤 없음)');
    const fitW = await q(`Math.round(document.getElementById('remoteCanvas').getBoundingClientRect().width)`);
    ok(fitW <= 400, `맞춤 상태에서는 화면 전체가 폭에 들어옴 (캔버스 ${fitW}px)`);

    // 4) 확대(원본 크기) ↔ 맞춤
    await q(`document.getElementById('remoteZoom').click(); 1`); await sleep(300);
    const z = await q(`(() => { const st = document.querySelector('.remote-stage'); return { zoom: st.classList.contains('zoom'), w: Math.round(document.getElementById('remoteCanvas').getBoundingClientRect().width), sw: st.scrollWidth, cw: st.clientWidth, label: document.getElementById('remoteZoom').textContent }; })()`);
    ok(z.zoom && z.w >= 1270 && z.sw > z.cw && z.label === '맞춤', `확대하면 원본 크기(약 1280px)로 커지고 밀어서 볼 수 있음: ${JSON.stringify(z)}`);
    await q(`document.querySelector('.remote-stage').scrollLeft = 500; 1`); await sleep(200);
    ok((await q(`document.querySelector('.remote-stage').scrollLeft`)) > 0, '확대한 화면을 옆으로 밀어 이동할 수 있음');
    await q(`document.getElementById('remoteZoom').click(); 1`); await sleep(300);
    ok(await q(`!document.querySelector('.remote-stage').classList.contains('zoom') && Math.round(document.getElementById('remoteCanvas').getBoundingClientRect().width) <= 400 && document.getElementById('remoteZoom').textContent === '확대'`), '"맞춤"을 누르면 다시 폭에 맞음');

    // 5) 보는 동안 화면이 꺼지지 않게 / 나가면 해제
    const w1 = JSON.parse(await q(`JSON.stringify(window.__wake)`));
    ok(w1.req >= 1 && w1.rel === 0, `보는 동안 화면 켜 두기를 요청함 (요청 ${w1.req}번)`);
    await q(`document.getElementById('remoteBack').click(); 1`); await sleep(600);
    const w2 = JSON.parse(await q(`JSON.stringify(window.__wake)`));
    ok(w2.rel >= 1, `나가면 화면 켜 두기를 해제함 (해제 ${w2.rel}번)`);
    ok(await q(`!document.getElementById('chat').hidden && document.querySelector('.remote-stage').classList.contains('zoom') === false`), '뒤로 가면 메신저로 돌아오고 확대 상태도 초기화');
    tab.close();
  } catch (e) { console.log('ERROR', e); }
  agent?.kill();
  process.exit(0);
})();
