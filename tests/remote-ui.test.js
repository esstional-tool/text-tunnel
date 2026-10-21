// 원격 보는 화면 시험 (이슈 #17, #21) — 실제 에이전트 + 헤드리스 Edge(원격 디버깅 9333). Windows 전용.
//   1) agent\build-agent.cmd 로 빌드  2) Edge 를 --remote-debugging-port=9333 으로 띄움  3) 서버 띄움
//   node tests/remote-ui.test.js http://localhost:8787
// ⚠ 에이전트가 이 PC 화면을 찍어 지정한 서버로 보낸다 — 로컬 서버로만. 캔버스 내용은 읽지 않고 크기·문구·번호만 본다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2], D = 'http://127.0.0.1:9333';
const PIN = '482915';
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
  const sink = path.join(cfg, 'sink.log'); // 에이전트가 실제 입력 대신 기록하는 파일 (이 시험은 이 PC 의 마우스·키보드를 건드리지 않는다)
  // 실제 화면 대신 합성 화면(--fake-screen)을 쓴다: 바뀌는 곳을 정확히 정할 수 있고, 이 PC 의 화면 내용을 읽지 않는다
  const fake = (...rects) => {
    const f = path.join(cfg, 'fs.tmp');
    fs.writeFileSync(f, ['size 1280 720', ...rects.map((r) => 'rect ' + r.join(' '))].join('\n'));
    for (let i = 0; i < 10; i++) { try { fs.renameSync(f, path.join(cfg, 'fake-screen.txt')); return; } catch {} }
  };
  let anim = null, step = 0;
  const startAnim = () => { anim = setInterval(() => fake([40 + (step++ % 20) * 50, 100, 60, 60, 255, 120, 0]), 250); };
  const stopAnim = () => { clearInterval(anim); anim = null; };
  fake();
  const sinkLines = () => (fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean) : []);
  let agent;
  try {
    const { key } = await post('pair/start', {});
    startAnim();
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
    agent = spawn(EXE, ['--server', B, '--code', code, '--config', cfg, '--set-pin', PIN, '--quiet', '--allow-control', '--input-sink', sink, '--fake-screen', cfg], { stdio: 'ignore' }); // PIN 은 이 PC 의 주인이 에이전트에서 정함
    await sleep(4000);
    const text = (id) => tab.evaluate(`document.getElementById('${id}').textContent`);
    const hidden = (id) => tab.evaluate(`document.getElementById('${id}').hidden`);
    const type = (v) => tab.evaluate(`(() => { const i = document.getElementById('pinInput'); i.value = '${v}'; document.getElementById('pinForm').requestSubmit(); return 1; })()`);

    // 열쇠가 있어도 PIN 을 넣기 전에는 화면이 없다
    ok((await text('remoteStatus')).includes('PIN 을 입력하세요') && !(await hidden('pinForm')), `에이전트가 켜지면 PIN 입력칸이 나옴: "${await text('remoteStatus')}"`);
    ok(await hidden('remoteEmpty'), '"에이전트를 켜 두세요" 안내는 사라지고 PIN 입력칸이 대신 나옴');
    ok((await text('remoteStats')) === '', 'PIN 을 넣기 전에는 화면도 속도 표시도 없음');

    await type('000000'); await sleep(1500);
    ok((await text('pinMsg')).includes('PIN 이 맞지 않아요') && (await text('pinMsg')).includes('4번'), `틀리면 남은 횟수가 보임: "${await text('pinMsg')}"`);
    ok(!(await hidden('pinForm')) && (await text('remoteStats')) === '', '틀린 뒤에도 입력칸이 남고 화면은 없음');
    ok(await tab.evaluate(`!document.getElementById('pinInput').disabled && document.getElementById('pinInput').value === ''`), '틀린 PIN 은 지워지고 다시 입력할 수 있음');

    await type(PIN); await sleep(3500);
    const status = await text('remoteStatus');
    ok(status.includes('화면을 받는 중') && (await hidden('pinForm')), `맞는 PIN 을 넣으면 화면이 나옴: "${status}"`);
    const dims = await tab.evaluate(`[document.getElementById('remoteCanvas').width, document.getElementById('remoteCanvas').height]`);
    ok(dims[0] === 1280 && dims[1] > 0, `캔버스가 원격 화면 크기로 바뀜 (${dims[0]}x${dims[1]})`);
    const stats = await tab.evaluate(`document.getElementById('remoteStats').textContent`);
    const fps = Number(/초당 ([\d.]+)번/.exec(stats)?.[1]);
    ok(fps >= 2, `화면을 받고 있음 — ${stats}`);
    await sleep(1500);
    const stats2 = await tab.evaluate(`document.getElementById('remoteStats').textContent`);
    ok(stats2 && stats2.includes('초당'), '속도 표시가 계속 갱신됨');

    // ── 바뀐 부분만 (이슈 #24): 조각이 캔버스에 올바르게 덧그려지는지 픽셀로 확인
    stopAnim(); await sleep(800);
    const px = (x, y) => tab.evaluate(`(() => { const d = document.getElementById('remoteCanvas').getContext('2d').getImageData(${x}, ${y}, 1, 1).data; return [d[0], d[1], d[2]]; })()`);
    const near = (a, b, tol = 28) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    fake([200, 300, 200, 100, 255, 0, 0], [800, 500, 100, 100, 0, 200, 0]); await sleep(1500);
    ok(near(await px(300, 350), [255, 0, 0]) && near(await px(850, 550), [0, 200, 0]) && near(await px(1000, 60), [28, 30, 54]), `합성 화면의 빨강·초록 사각형과 바탕이 캔버스에 맞게 그려짐: ${JSON.stringify([await px(300, 350), await px(850, 550), await px(1000, 60)])}`);
    fake([200, 300, 200, 100, 255, 0, 0], [900, 500, 100, 100, 0, 200, 0]); await sleep(1500); // 초록만 옆으로 옮김 → 그 부분만 조각으로 옴
    ok(near(await px(950, 550), [0, 200, 0]) && near(await px(850, 550), [28, 30, 54]) && near(await px(300, 350), [255, 0, 0]), `일부만 바뀌어도 나머지는 그대로이고 바뀐 곳만 갱신됨 (옛 자리는 바탕으로, 새 자리는 초록, 빨강은 유지)`);
    ok((await tab.evaluate(`document.getElementById('remoteStats').textContent`)).includes('조각'), '속도 표시에 조각 수가 보임');
    // ── 화질·속도 (이슈 #25): 프로필 선택 → 에이전트가 따르고, 현재 상태가 표시됨
    ok(await tab.evaluate(`!document.getElementById('remoteProfile').hidden`), 'PIN 통과 후 화질·속도 선택칸이 보임');
    await sleep(2500); // (합성 화면은 빨강·초록 사각형 그대로 둔다 — 크기가 바뀐 뒤 위치 확인용)
    const info1 = await tab.evaluate(`document.getElementById('remoteInfo').textContent`);
    ok(/^자동 · 화질 [0-9]+ · 전송 [0-9]+ms · 간격 [0-9]+ms · PNG [0-9]+ [/] JPEG [0-9]+ 조각 · 1280px$/.test(info1), `에이전트가 알려 준 현재 화질·전송 시간·조각 형식 수가 표시됨: "${info1}"`);
    await tab.evaluate(`(() => { const s = document.getElementById('remoteProfile'); s.value = 'speed'; s.dispatchEvent(new Event('change')); return 1; })()`); await sleep(4000);
    const w960 = await tab.evaluate(`document.getElementById('remoteCanvas').width`);
    const info2 = await tab.evaluate(`document.getElementById('remoteInfo').textContent`);
    ok(w960 === 960 && info2.startsWith('속도 우선'), `"속도 우선"을 고르면 화면이 960px 로 줄고 표시가 바뀜: 캔버스 ${w960}px, "${info2}"`);
    ok(near(await px(Math.round(950 * 0.75), Math.round(550 * 0.75)), [0, 200, 0]) && near(await px(Math.round(300 * 0.75), Math.round(350 * 0.75)), [255, 0, 0], 40), '크기가 바뀐 뒤에도 그림이 올바르게 다시 그려짐 (빨강·초록 위치가 비율대로)');
    await tab.evaluate(`(() => { const s = document.getElementById('remoteProfile'); s.value = 'auto'; s.dispatchEvent(new Event('change')); return 1; })()`); await sleep(4000);
    ok((await tab.evaluate(`document.getElementById('remoteCanvas').width`)) === 1280, '"자동"으로 되돌리면 1280px 로 복귀');

    // ── 조종 (이슈 #23): 단추 → 캔버스 이벤트 → 입력 묶음 → 에이전트 (실제 입력은 sink 파일에 기록)
    const ctl = () => tab.evaluate(`(() => { const b = document.getElementById('remoteCtl'); return { hidden: b.hidden, disabled: b.disabled, text: b.textContent, on: b.classList.contains('on'), stage: document.querySelector('.remote-stage').classList.contains('ctl') }; })()`);
    const fire = (js) => tab.evaluate(`(() => { const c = document.getElementById('remoteCanvas'); const r = c.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; ${js} })()`);
    let c0 = await ctl();
    ok(!c0.hidden && !c0.disabled && c0.text === '조종 켜기' && !c0.on, `PIN 통과 후 "조종 켜기" 단추가 나타남 (주인이 허용한 PC): ${JSON.stringify(c0)}`);
    await fire(`c.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true })); return 1;`); await sleep(400);
    ok(sinkLines().length === 0, '조종을 켜기 전에는 캔버스 위에서 움직여도 아무것도 전송되지 않음');
    await tab.evaluate(`document.getElementById('remoteCtl').click(); 1`); await sleep(1200);
    c0 = await ctl();
    ok(c0.text === '조종 끄기' && c0.on && c0.stage, `단추를 누르면 조종이 켜지고 화면에 표시(테두리)됨: ${JSON.stringify(c0)}`);
    ok(await tab.evaluate(`document.activeElement === document.getElementById('remoteCanvas')`), '조종이 켜지면 캔버스에 포커스가 가서 키 입력을 받을 수 있음');
    const prevented = await fire(`
      c.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }));
      c.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, button: 0, bubbles: true, cancelable: true }));
      c.dispatchEvent(new MouseEvent('mouseup', { clientX: cx, clientY: cy, button: 0, bubbles: true, cancelable: true }));
      const w = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }); c.dispatchEvent(w);
      const k1 = new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true, cancelable: true }); c.dispatchEvent(k1);
      c.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', bubbles: true, cancelable: true }));
      return [w.defaultPrevented, k1.defaultPrevented];`);
    await sleep(1200);
    const L = sinkLines();
    ok(L.some((x) => /^move 12[78]\d /.test(x)) && L.includes('mouse 2 0') && L.includes('mouse 4 0'), `캔버스 가운데 클릭이 원격 화면 가운데(좌표 비율)로 전달됨: ${L.join(" | ")}`);
    ok(L.includes('mouse 2048 -120'), '휠 전달');
    ok(L.includes('key 65 0') && L.includes('key 65 2'), 'A 키 누름·뗌 전달 (KeyA → VK 65)');
    ok(prevented[0] === true && prevented[1] === true, '조종 중에는 브라우저 기본 동작(스크롤·단축키)을 막아 원격 PC 로만 보냄');
    await tab.evaluate(`document.getElementById('remoteCtl').click(); 1`); await sleep(1500);
    c0 = await ctl();
    ok(c0.text === '조종 켜기' && !c0.on && !c0.stage, '단추를 다시 누르면 조종이 꺼짐');
    const n = sinkLines().length;
    await fire(`c.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, button: 0, bubbles: true })); return 1;`); await sleep(500);
    ok(sinkLines().length === n, '끈 뒤에는 입력이 전송되지 않음');

    stopAnim();
    // 에이전트를 끈다
    agent.kill(); await sleep(2500);
    ok((await tab.evaluate(`document.getElementById('remoteStatus').textContent`)).includes('꺼져 있어요'), '에이전트가 꺼지면 "꺼져 있어요"로 바뀜');
    ok(await tab.evaluate(`!document.getElementById('remoteEmpty').hidden && document.getElementById('remoteStats').textContent === '' && document.getElementById('pinForm').hidden`), '안내가 다시 나오고 속도 표시가 지워지며 입력칸은 숨겨짐');

    // 에이전트를 다시 켠다 (저장된 열쇠·PIN 으로). 새로 켠 에이전트는 이전 인증을 인정하지 않으므로 다시 인증해야 하고,
    // 방금 성공한 PIN 이 이 화면의 메모리에 있으면 한 번만 자동으로 다시 넣는다 (사용자가 또 입력하지 않게)
    agent = spawn(EXE, ['--server', B, '--config', cfg, '--quiet', '--fake-screen', cfg], { stdio: 'ignore' });
    await sleep(5500);
    const again = await text('remoteStatus');
    ok(again.includes('화면을 받는 중') && (await hidden('pinForm')), `에이전트가 다시 켜지면 방금 쓴 PIN 으로 자동 재인증되어 화면이 다시 옴: "${again}"`);
    agent.kill(); await sleep(2000);

    // 뒤로 가기: 메신저로 돌아오고 보는 사람 연결을 정리한다
    await tab.evaluate(`document.getElementById('remoteBack').click(); 1`);
    await sleep(800);
    ok(await tab.evaluate(`!document.getElementById('chat').hidden && document.getElementById('remoteScreen').hidden`), '뒤로 가면 메신저로 돌아옴');
    ok(await tab.evaluate(`document.getElementById('pinInput').value === '' && document.getElementById('pinForm').hidden`), '나가면 입력한 PIN 도 화면에서 지워짐 (저장하지 않음)');
    ok(!(await tab.evaluate(`JSON.stringify(localStorage) + JSON.stringify(sessionStorage)`)).includes(PIN), 'PIN 은 브라우저 저장소(localStorage·sessionStorage)에 어디에도 저장되지 않음');
    tab.close();
  } finally {
    try { agent?.kill(); } catch {}
    fs.rmSync(cfg, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
