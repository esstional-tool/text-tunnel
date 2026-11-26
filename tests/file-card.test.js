// 채팅 파일 카드 시험 (이슈 #61): 서버 + Edge(--remote-debugging-port=9333) 를 띄운 뒤
//   node tests/file-card.test.js http://localhost:8787
// 받은 파일 말풍선에 "저장"·"공유" 글씨 버튼이 보이는지 확인한다.
const D = 'http://127.0.0.1:9333';
const base = process.argv[2];
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, evaluate: async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value, close: () => ws.close() };
}

(async () => {
  let tab;
  try {
    const t = await (await fetch(`${D}/json/new?${encodeURIComponent(base + '/')}`, { method: 'PUT' })).json();
    tab = await cdp(t.webSocketDebuggerUrl);
    await tab.call('Page.enable');
    await tab.call('Emulation.setDeviceMetricsOverride', { width: 400, height: 820, deviceScaleFactor: 2, mobile: true });
    await tab.call('Page.navigate', { url: `${base}/#demo-chat` }); await sleep(2000);
    const r = await tab.evaluate(`(() => {
      add({ type: 'file', from: 'p', name: '휴대폰', fid: 'x1', fname: '1795656242400.jpg', mime: 'image/jpeg', size: 1024 * 300, at: Date.now() - 1000 });
      add({ type: 'file', from: 'p', name: '휴대폰', fid: 'x2', fname: 'manual.zip', mime: 'application/zip', size: 5 * 1024 * 1024, at: Date.now() });
      const cards = [...document.querySelectorAll('.bubble.doc')];
      const last = cards[cards.length - 1];
      const save = last.querySelector('.doc-save');
      const share = last.querySelector('.doc-share');
      const r = last.getBoundingClientRect();
      const sr = save ? save.getBoundingClientRect() : null;
      return {
        count: cards.length,
        saveText: save ? save.textContent.trim() : null,
        saveHref: save ? save.getAttribute('href') : null,
        saveDownload: save ? save.getAttribute('download') : null,
        saveVisible: !!sr && sr.width > 40 && sr.height > 24,
        shareText: share && !share.hidden ? share.textContent.trim() : null,
        cardWide: r.width > 200,
        oldRound: [...last.querySelectorAll('.save')].some((e) => !e.textContent.includes('저장')) };
    })()`);
    ok(r.count >= 2, '파일 말풍선이 그려짐');
    ok(r.saveText === '저장', '말풍선에 "저장" 글씨 버튼이 있음');
    ok(r.saveVisible, `"저장" 버튼이 보일 만한 크기 (모바일 화면)`);
    ok(r.saveDownload === 'manual.zip' && r.saveHref, '"저장"은 파일 이름으로 내려받는 링크');
    ok(r.cardWide, '카드가 말풍선 폭만큼 넓음');
    ok(!r.oldRound, '예전의 작은 원형 저장 아이콘은 없음');
    console.log('INFO 공유 버튼:', r.shareText ?? '(이 브라우저에서는 공유 안 됨 — 정상)');
  } catch (e) { console.log('ERROR', e); }
  try { tab?.close(); } catch {}
  process.exit(0);
})();
