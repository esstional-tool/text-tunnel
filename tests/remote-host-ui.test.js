// "이 PC 원격 허용 켜기" 화면 시험 (이슈 #30) — 실제 에이전트 + 헤드리스 Edge(원격 디버깅 9333). Windows 전용.
//   1) agent\build-agent.cmd 로 빌드  2) Edge 를 --remote-debugging-port=9333 으로 띄움  3) 서버 띄움
//   node tests/remote-host-ui.test.js http://localhost:8787
// 에이전트는 --fake-screen 으로 띄워 이 PC 의 화면 내용을 읽지 않는다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2], D = 'http://127.0.0.1:9333';
const EXE = path.join(__dirname, '..', 'agent', 'remote-agent.exe');
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, evaluate: async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value, close: () => ws.close() };
}

(async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-host-'));
  let agent;
  try {
    const { key } = await post('pair/start', {});
    const t = await (await fetch(`${D}/json/new?${encodeURIComponent(B + '/')}`, { method: 'PUT' })).json();
    let tab = await cdp(t.webSocketDebuggerUrl);
    await sleep(1500);
    await tab.evaluate(`localStorage.setItem('tt.key', ${JSON.stringify(key)}); localStorage.setItem('tt.device', 'host-test'); localStorage.setItem('tt.name', 'PC'); location.reload(); 1`);
    tab.close(); await sleep(3500);
    tab = await cdp(t.webSocketDebuggerUrl);
    const text = (id) => tab.evaluate(`document.getElementById('${id}').textContent`);
    const waitText = async (id, re, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (re.test(await text(id))) return true; await sleep(100); } return false; };

    ok(await tab.evaluate(`!document.getElementById('mHost').hidden && document.getElementById('mHost').textContent.includes('이 PC 원격 허용 켜기')`), '메뉴에 "이 PC 원격 허용 켜기 (에이전트)"가 있음 (PC)');
    await tab.evaluate(`document.getElementById('menuBtn').click(); document.getElementById('mHost').click(); 1`);
    await sleep(1200);
    ok(await tab.evaluate(`!document.getElementById('hostScreen').hidden && document.getElementById('chat').hidden`), '안내 화면으로 전환됨');
    ok(await waitText('hostStatus', /꺼져 있어요/), `에이전트가 없으면 "꺼져 있어요": "${await text('hostStatus')}"`);
    const dl = await tab.evaluate(`(() => { const a = document.getElementById('hostDl'); return { href: a.getAttribute('href'), dl: a.hasAttribute('download') }; })()`);
    ok(dl.href === '/text-tunnel-agent.zip' && dl.dl, '"에이전트 받기" 링크가 zip 을 가리킴');
    ok(await tab.evaluate(`document.getElementById('hostCodeBox').hidden`), '연결 코드는 누르기 전에는 보이지 않음');

    await tab.evaluate(`document.getElementById('hostCodeBtn').click(); 1`); await sleep(1500);
    const cmd = await text('hostCmd');
    const m = /^\.\\run-agent\.cmd --code ([A-Z0-9]{6})$/.exec(cmd);
    ok(!!m, `연결 코드를 만들면 실행 명령이 나옴: "${cmd}"`);
    ok((await text('hostTimer')).includes('안에 실행하세요'), `만료까지 남은 시간이 보임: "${await text('hostTimer')}"`);
    const claimed = await post('pair/claim', { code: m?.[1] });
    ok(claimed.key === key, '이 코드로 에이전트가 받는 열쇠가 이 앱의 짝 열쇠와 같음 (같은 짝)');
    ok((await tab.evaluate(`document.getElementById('hostCopy').textContent`)) === '복사', '복사 단추가 있음');

    // 에이전트를 켠다 → 상태가 "켜져 있어요" 로
    const { code } = await post('pair/start', { key });
    agent = spawn(EXE, ['--server', B, '--config', cfg, '--code', code, '--set-pin', '482915', '--quiet', '--fake-screen', cfg], { stdio: 'ignore' });
    ok(await waitText('hostStatus', /켜져 있어요/, 10000), `에이전트가 켜지면 실시간으로 "켜져 있어요": "${await text('hostStatus')}"`);
    ok(await tab.evaluate(`document.getElementById('hostDot').classList.contains('on')`), '상태 점이 켜짐 색으로 바뀜');
    agent.kill();
    ok(await waitText('hostStatus', /꺼져 있어요/, 10000), '에이전트를 끄면 다시 "꺼져 있어요"');

    await tab.evaluate(`document.getElementById('hostBack').click(); 1`); await sleep(800);
    ok(await tab.evaluate(`!document.getElementById('chat').hidden && document.getElementById('hostScreen').hidden`), '뒤로 가면 메신저로 돌아옴');

    // 원격 화면 보기 쪽 안내도 새 메뉴를 가리킴
    await tab.evaluate(`document.getElementById('menuBtn').click(); document.getElementById('mRemote').click(); 1`); await sleep(1500);
    ok((await tab.evaluate(`document.getElementById('remoteEmpty').textContent`)).includes('이 PC 원격 허용 켜기'), '"원격 화면 보기"의 안내 문구가 새 메뉴를 알려 줌');
    tab.close();
  } catch (e) { console.log('ERROR', e); }
  agent?.kill();
  process.exit(0);
})();
