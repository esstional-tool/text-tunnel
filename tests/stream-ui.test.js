// 큰 파일 PC 직접 저장 화면 시험 (이슈 #55): 서버 + Edge(--remote-debugging-port=9333) 를 띄운 뒤
//   node tests/stream-ui.test.js http://localhost:8787
// 보내는 쪽은 안드로이드 화면(모바일 UA), 받는 쪽은 PC 화면. 두 탭은 주소가 달라(localhost / 127.0.0.1) 저장소가 따로다.
// Edge 에는 실제 저장 창을 열 수 없어서, 시험에서만 showSaveFilePicker 를 메모리에 받는 가짜로 바꾼다 (받은 내용은 해시로 원본과 비교).
const crypto = require('crypto');
const D = 'http://127.0.0.1:9333';
const base = process.argv[2];
const HOST_URL = base.replace('127.0.0.1', 'localhost'), FRIEND_URL = base.replace('localhost', '127.0.0.1');
const MB = Number(process.env.STREAM_UI_MB) || 20;
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, evaluate: async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value, close: () => ws.close() };
}
async function openTab(url, ua, mobile, key, device, name) {
  const t = await (await fetch(`${D}/json/new?about:blank`, { method: 'PUT' })).json();
  const tab = await cdp(t.webSocketDebuggerUrl);
  await tab.call('Page.enable');
  await tab.call('Emulation.setUserAgentOverride', { userAgent: ua });
  await tab.call('Emulation.setDeviceMetricsOverride', mobile ? { width: 400, height: 820, deviceScaleFactor: 2, mobile: true } : { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false });
  await tab.call('Page.navigate', { url }); await sleep(1500);
  await tab.evaluate(`localStorage.setItem('tt.key', ${JSON.stringify(key)}); localStorage.setItem('tt.device', ${JSON.stringify(device)}); localStorage.setItem('tt.name', ${JSON.stringify(name)}); 1`);
  await tab.call('Page.reload'); await sleep(2500);
  return tab;
}
async function waitFor(fn, ms = 20000) { for (let i = 0; i < ms / 200; i++) { if (await fn()) return true; await sleep(200); } return false; }

(async () => {
  let pc, phone;
  try {
    const s = await (await fetch(`${base}/api/pair/start`, { method: 'POST', body: '{}' })).json();
    const key = s.key;
    pc = await openTab(`${HOST_URL}/`, PC_UA, false, key, 'pc-stream', 'PC');
    phone = await openTab(`${FRIEND_URL}/`, ANDROID_UA, true, key, 'phone-stream', '휴대폰');
    ok(await waitFor(async () => (await pc.evaluate(`document.getElementById('status').textContent`)).includes('연결됨') || (await pc.evaluate(`document.getElementById('status').textContent`)).includes('기다리는')), 'PC 가 방에 들어감');
    ok(await waitFor(async () => (await phone.evaluate(`typeof others === 'number' && others >= 1`))), '휴대폰이 PC 를 봄');

    // PC: 가짜 저장 창 (받은 조각을 메모리에 모으고 해시를 낸다)
    await pc.evaluate(`window.__got = []; window.__closed = false; window.__aborted = false;
      window.showSaveFilePicker = async (opts) => { window.__suggested = opts && opts.suggestedName; return { createWritable: async () => ({
        write: async (c) => { window.__got.push(new Uint8Array(c)); },
        close: async () => { window.__closed = true; },
        abort: async () => { window.__aborted = true; } }) }; };
      1`);

    // 휴대폰: 보낼 파일을 만든다 (무작위 바이트)
    const made = await phone.evaluate(`(async () => {
      const n = ${MB} * 1024 * 1024; const buf = new Uint8Array(n);
      for (let o = 0; o < n; o += 65536) crypto.getRandomValues(buf.subarray(o, Math.min(n, o + 65536)));
      const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');
      window.__sendFile = new File([buf], 'big-sample.bin', { type: 'application/octet-stream' });
      window.__sendSha = h; return n; })()`);
    ok(made === MB * 1024 * 1024, `휴대폰에서 ${MB}MB 샘플 파일 준비`);

    // 휴대폰: 트레이에 담고, "PC에 바로 저장" 을 켠 뒤 보내기
    await phone.evaluate(`addToTray([window.__sendFile]); 1`);
    await sleep(800);
    ok(await phone.evaluate(`!document.getElementById('streamWrap').hidden`), '휴대폰 트레이에 "PC에 바로 저장" 칸이 보임');
    ok(await pc.evaluate(`document.getElementById('streamWrap') ? document.getElementById('streamWrap').hidden : true`), 'PC 트레이에는 그 칸이 숨겨져 있음 (PC 는 받는 쪽)');
    await phone.evaluate(`document.getElementById('streamToggle').checked = true; sendTray(); 1`);

    // PC: 받기 카드가 떠야 한다
    ok(await waitFor(() => pc.evaluate(`!!document.querySelector('.stream-accept')`)), 'PC 에 "파일 받기" 카드가 뜸');
    ok(await pc.evaluate(`document.querySelector('.stream-info').textContent.includes('big-sample.bin')`), '카드에 파일 이름과 크기가 보임');
    await pc.evaluate(`document.querySelector('.stream-accept').click(); 1`);

    // 완료: PC 쪽 카드가 "저장했어요"로 바뀌고, 휴대폰은 보내기 말풍선을 치운다
    ok(await waitFor(() => pc.evaluate(`(document.querySelector('.stream-state') && document.querySelector('.stream-state').textContent || '').includes('저장했어요')`), 240000), 'PC 쪽 카드가 "저장했어요"로 바뀜');
    await sleep(600);
    const got = await pc.evaluate(`(async () => {
      const total = window.__got.reduce((a, b) => a + b.length, 0);
      const all = new Uint8Array(total); let o = 0; for (const p of window.__got) { all.set(p, o); o += p.length; }
      const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', all))).map((b) => b.toString(16).padStart(2, '0')).join('');
      return { total, h, closed: window.__closed, aborted: window.__aborted, suggested: window.__suggested }; })()`);
    ok(got.total === MB * 1024 * 1024 && got.h === await phone.evaluate('window.__sendSha'), `PC 에 저장된 내용이 원본과 같음 (${MB}MB, sha256 일치)`);
    ok(got.closed === true && got.aborted === false && got.suggested === 'big-sample.bin', '저장 파일이 제대로 닫히고, 기본 이름으로 제안됨');
    ok(await phone.evaluate(`!document.querySelector('.bubble.pending')`), '휴대폰의 보내기 말풍선은 끝나고 정리됨');

    // 가짜 저장 창이 없는 브라우저에서는 받지 않고 안내만 한다
    await pc.evaluate(`window.showSaveFilePicker = undefined; 1`);
    await phone.evaluate(`(async () => { await addToTray([new File(['hello'], 'hi.txt', { type: 'text/plain' })]); document.getElementById('streamToggle').checked = true; sendTray(); })()`);
    await sleep(1500);
    ok(await waitFor(() => pc.evaluate(`!!document.querySelector('.stream-accept')`)), '두 번째 제안도 카드로 뜸');
    await pc.evaluate(`document.querySelector('.stream-accept').click(); 1`);
    ok(await waitFor(() => pc.evaluate(`document.getElementById('toast').textContent.includes('바로 저장할 수 없어요')`)), '저장 창이 없는 브라우저에서는 "바로 저장할 수 없어요" 안내');
  } catch (e) { console.log('ERROR', e); }
  try { pc?.close(); phone?.close(); } catch {}
  process.exit(0);
})();
