// 폰 원격 조종 보는 화면 시험 (이슈 #46) — 헤드리스 Edge(원격 디버깅 9333) + 가짜 폰 에이전트. 서버를 띄운 뒤
//   node tests/remote-phone-ui.test.js http://localhost:8787
// 에이전트가 platform:'android' 로 입장하면 보는 화면이 폰 도구줄(뒤로·홈·최근·알림, 글자 보내기)을 보여주고 그 입력이 서버로 가는지 확인한다.
const crypto = require('crypto');
const B = process.argv[2], D = 'http://127.0.0.1:9333';
const PIN = '482915';
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
// 가짜 에이전트: PIN 확인·조종 허용·받은 입력 기록 (platform 을 정할 수 있음)
async function fakeAgent(key, platform) {
  const j = await post('remote/agent/join', { key, name: platform === 'android' ? '내 폰' : '노트북', ...(platform ? { platform } : {}) });
  const inputs = []; const ac = new AbortController();
  fetch(`${B}/api/remote/agent/events?token=${j.token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (!d) continue; const e = JSON.parse(d);
        if (e.type === 'auth') post(`remote/agent/auth?token=${j.token}`, { vid: e.vid, ok: e.pin === PIN, left: 4, code: e.pin === PIN ? '' : 'wrong' });
        if (e.type === 'viewers' && !fakeAgent.reported) { fakeAgent.reported = true; post(`remote/agent/control?token=${j.token}`, { allowed: true }); }
        if (e.type === 'input') inputs.push(...e.ev);
      }
    }
  }).catch(() => {});
  return { token: j.token, inputs, stop: async () => { ac.abort(); await fetch(`${B}/api/remote/leave?token=${j.token}`, { method: 'POST' }); fakeAgent.reported = false; } };
}

(async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  let ag;
  try {
    const t = await (await fetch(`${D}/json/new?about:blank`, { method: 'PUT' })).json();
    const tab = await cdp(t.webSocketDebuggerUrl);
    await tab.call('Page.enable');
    await tab.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false });
    await tab.call('Page.navigate', { url: `${B}/` }); await sleep(800);
    await tab.evaluate(`localStorage.setItem('tt.key', ${JSON.stringify(key)}); localStorage.setItem('tt.device', 'phone-ui'); localStorage.setItem('tt.name', 'PC'); 1`);
    await tab.call('Page.reload'); await sleep(3000);
    const q = (js) => tab.evaluate(js);
    const hidden = (id) => q(`document.getElementById('${id}').hidden`);

    // ── 폰 에이전트 ──
    ag = await fakeAgent(key, 'android'); await sleep(500);
    await q(`document.getElementById('menuBtn').click(); document.getElementById('mRemote').click(); 1`); await sleep(1500);
    await q(`(() => { document.getElementById('pinInput').value = '${PIN}'; document.getElementById('pinForm').requestSubmit(); return 1; })()`); await sleep(2500);
    ok(await hidden('remotePhoneBar'), '폰 도구줄은 조종을 켜기 전에는 보이지 않음');
    await sleep(500);
    await q(`document.getElementById('remoteCtl').click(); 1`); await sleep(1500);
    ok(!(await hidden('remotePhoneBar')), '폰 에이전트에서 조종을 켜면 폰 도구줄(뒤로·홈·최근·알림·글자 보내기)이 나타남');
    ok((await q(`[...document.querySelectorAll('#remotePhoneBar [data-nav]')].map((b) => b.dataset.nav).join(',')`)) === 'back,home,recents,notifications', '이동 단추: 뒤로·홈·최근·알림');

    await q(`document.querySelector('#remotePhoneBar [data-nav=home]').click(); document.querySelector('#remotePhoneBar [data-nav=back]').click(); 1`); await sleep(700);
    ok(ag.inputs.filter((e) => e.t === 'n').map((e) => e.a).join(',') === 'home,back', `단추를 누르면 이동 동작이 서버를 거쳐 폰 에이전트에 도착: ${JSON.stringify(ag.inputs.filter((e) => e.t === 'n'))}`);
    await q(`(() => { document.getElementById('phoneText').value = '안녕하세요 ㅎㅎ'; document.getElementById('phoneTextForm').requestSubmit(); return 1; })()`); await sleep(700);
    ok(ag.inputs.some((e) => e.t === 's' && e.s === '안녕하세요 ㅎㅎ') && (await q(`document.getElementById('phoneText').value`)) === '', '"폰에 글자 보내기"의 한글이 그대로 도착하고 입력칸은 비워짐');
    await q(`(() => { const c = document.getElementById('remoteCanvas'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true })); c.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true })); c.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', ctrlKey: true, bubbles: true, cancelable: true })); return 1; })()`); await sleep(700);
    const ks = ag.inputs.filter((e) => e.t === 'k' && e.d === 1);
    ok(ks.length === 2 && ks[0].ch === 'a' && ks[1].ch === undefined, `키보드 글자가 함께 전달됨 (a → ch 'a', Ctrl+A 는 글자 없음): ${JSON.stringify(ks.map((k) => k.ch))}`);

    await q(`document.getElementById('remoteCtl').click(); 1`); await sleep(800);
    ok(await hidden('remotePhoneBar'), '조종을 끄면 폰 도구줄도 사라짐');
    await q(`document.getElementById('remoteBack').click(); 1`); await sleep(400);
    await ag.stop(); await sleep(500);

    // ── PC 에이전트(platform 을 안 알림)에는 폰 도구줄이 나오지 않는다 ──
    ag = await fakeAgent(key); await sleep(500);
    await q(`document.getElementById('menuBtn').click(); document.getElementById('mRemote').click(); 1`); await sleep(1500);
    await q(`(() => { document.getElementById('pinInput').value = '${PIN}'; document.getElementById('pinForm').requestSubmit(); return 1; })()`); await sleep(2500);
    await q(`document.getElementById('remoteCtl').click(); 1`); await sleep(1500);
    ok(await hidden('remotePhoneBar') && (await q(`document.getElementById('remoteCtl').textContent`)) === '조종 끄기', 'PC 에이전트에서는 조종을 켜도 폰 도구줄이 나오지 않음');
    tab.close();
  } catch (e) { console.log('ERROR', e); }
  try { await ag?.stop(); } catch {}
  process.exit(0);
})();
