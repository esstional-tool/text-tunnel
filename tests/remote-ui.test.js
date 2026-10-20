// 원격 보는 화면 시험 (이슈 #17) — 실제 에이전트 + 헤드리스 Edge(원격 디버깅 9333). Windows 전용.
//   1) agent\build-agent.cmd 로 빌드  2) Edge 를 --remote-debugging-port=9333 으로 띄움  3) 서버 띄움
//   node tests/remote-ui.test.js http://localhost:8787
// ⚠ 에이전트가 이 PC 화면을 찍어 지정한 서버로 보낸다 — 로컬 서버로만. 캔버스 내용은 읽지 않고 크기·문구·번호만 본다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2], D = 'http://127.0.0.1:9333';
const EXE = path.join(__dirname, '..', 'agent', 'remote-agent.exe');
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

(async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agent-'));
  let agent;
  try {
    const { key } = await post('pair/start', {});
    // PC 앱: 메신저 짝 열쇠가 저장된 상태로 연다
    const t = await (await fetch(`${D}/json/new?${encodeURIComponent(B + '/')}`, { method: 'PUT' })).json();
    let tab = await cdp(t.webSocketDebuggerUrl);
    await sleep(1500);
    await tab.evaluate(`localStorage.setItem('tt.key', ${JSON.stringify(key)}); localStorage.setItem('tt.device', 'ui-test'); localStorage.setItem('tt.name', 'PC'); location.reload(); 1`);
    tab.close(); await sleep(3500);
    tab = await cdp(t.webSocketDebuggerUrl);

    ok(await tab.evaluate(`!document.getElementById('mRemote').hidden`), '메뉴에 "원격 화면 보기"가 있음 (PC)');
    await tab.evaluate(`document.getElementById('menuBtn').click(); document.getElementById('mRemote').click(); 1`);
    await sleep(1500);
    ok(await tab.evaluate(`!document.getElementById('remoteScreen').hidden && document.getElementById('chat').hidden`), '"원격 화면"으로 전환됨');
    ok((await tab.evaluate(`document.getElementById('remoteStatus').textContent`)).includes('꺼져 있어요'), `에이전트가 없을 때 안내: "${await tab.evaluate(`document.getElementById('remoteStatus').textContent`)}"`);
    ok(await tab.evaluate(`!document.getElementById('remoteEmpty').hidden`), '안내 화면(에이전트를 켜 두세요)이 보임');

    // 에이전트를 켠다 (짝 코드는 메신저 "새 기기 연결" 과 같은 방식)
    const { code } = await post('pair/start', { key });
    agent = spawn(EXE, ['--server', B, '--code', code, '--config', cfg], { stdio: 'ignore' });
    await sleep(4500);
    const status = await tab.evaluate(`document.getElementById('remoteStatus').textContent`);
    ok(status.includes('화면을 받는 중'), `에이전트가 켜지자 상태가 바뀜: "${status}"`);
    ok(await tab.evaluate(`document.getElementById('remoteEmpty').hidden`), '안내 화면이 사라짐');
    const dims = await tab.evaluate(`[document.getElementById('remoteCanvas').width, document.getElementById('remoteCanvas').height]`);
    ok(dims[0] === 1280 && dims[1] > 0, `캔버스가 원격 화면 크기로 바뀜 (${dims[0]}x${dims[1]})`);
    const stats = await tab.evaluate(`document.getElementById('remoteStats').textContent`);
    const fps = Number(/초당 ([\d.]+)장/.exec(stats)?.[1]);
    ok(fps >= 2, `화면을 받고 있음 — ${stats}`);
    await sleep(1500);
    const stats2 = await tab.evaluate(`document.getElementById('remoteStats').textContent`);
    ok(stats2 && stats2.includes('초당'), '속도 표시가 계속 갱신됨');

    // 에이전트를 끈다
    agent.kill(); await sleep(2500);
    ok((await tab.evaluate(`document.getElementById('remoteStatus').textContent`)).includes('꺼져 있어요'), '에이전트가 꺼지면 "꺼져 있어요"로 바뀜');
    ok(await tab.evaluate(`!document.getElementById('remoteEmpty').hidden && document.getElementById('remoteStats').textContent === ''`), '안내가 다시 나오고 속도 표시가 지워짐');

    // 뒤로 가기: 메신저로 돌아오고 보는 사람 연결을 정리한다
    await tab.evaluate(`document.getElementById('remoteBack').click(); 1`);
    await sleep(800);
    ok(await tab.evaluate(`!document.getElementById('chat').hidden && document.getElementById('remoteScreen').hidden`), '뒤로 가면 메신저로 돌아옴');
    tab.close();
  } finally {
    try { agent?.kill(); } catch {}
    fs.rmSync(cfg, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
