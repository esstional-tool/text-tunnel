// 받은 파일 공유(Web Share) 시험 (이슈 #35) — 실제 Edge(헤드리스, 원격 디버깅 9333). 서버를 띄운 뒤
//   node tests/share.test.js http://localhost:8787
// 시험용으로 navigator.share/canShare 를 가짜로 바꿔, 앱이 "어떤 파일(이름·형식·크기)을 넘기는지"와 허용 만료·취소·실패 흐름을 확인한다.
// 데모 화면(#demo-chat)에 파일 말풍선을 직접 추가해 쓰므로 서버·짝 맺기·진짜 공유창은 쓰지 않는다.
const B = process.argv[2], D = 'http://127.0.0.1:9333';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, evaluate: async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value, close: () => ws.close() };
}
// 공유창을 흉내 내는 가짜: 넘어온 파일을 기록하고, 시험이 정한 mode 대로 동작한다
const STUB = `
  window.__shared = []; window.__mode = 'ok';
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => window.__mode !== 'cannot' });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
    const mode = window.__mode;
    if (mode === 'abort') throw new DOMException('x', 'AbortError');
    if (mode === 'expired') { window.__mode = 'ok'; throw new DOMException('x', 'NotAllowedError'); }
    if (mode === 'error') throw new Error('boom');
    const head = d.files && d.files[0] ? new TextDecoder().decode(await d.files[0].slice(0, 8).arrayBuffer()) : '';
    window.__shared.push((d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size, head })));
  } });`;

(async () => {
  const t = await (await fetch(`${D}/json/new?about:blank`, { method: 'PUT' })).json();
  const tab = await cdp(t.webSocketDebuggerUrl);
  await tab.call('Page.enable');
  await tab.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: true });
  const stub = await tab.call('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  const open = async () => { await tab.call('Page.navigate', { url: `${B}/#demo-chat` }); await sleep(300); await tab.call('Page.reload'); await sleep(1600); };
  const q = (js) => tab.evaluate(js);
  const toastText = () => q(`document.getElementById('toast').textContent`);
  const click = (sel, i = 0) => q(`document.querySelectorAll(${JSON.stringify(sel)})[${i}].click(); 1`);
  const shared = () => q(`JSON.stringify(window.__shared)`).then(JSON.parse);
  const addFile = (fname, mime, uri, extra = '') => q(`add({ type: 'file', from: 'p', name: '휴대폰', fname: ${JSON.stringify(fname)}, mime: ${JSON.stringify(mime)}, size: 100, at: Date.now(), src: ${JSON.stringify(uri)} ${extra} }); 1`);
  const PDF = 'data:application/pdf;base64,JVBERi0xLjQK'; // "%PDF-1.4\n" = 9바이트
  const PDF2 = 'data:application/pdf;base64,JVBERi0xLjUK'; // 다른 주소(캐시가 겹치지 않게)
  const MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29t'; // 12바이트

  try {
    await open();
    await addFile('계약서.pdf', 'application/pdf', PDF);
    await addFile('회식.mp4', 'video/mp4', MP4);
    await sleep(300);

    // 1) 지원하는 기기: 버튼이 보임
    ok(await q(`!document.querySelector('.bubble.doc .share')?.hidden`), '문서 말풍선에 공유 버튼이 있음 (이 기기가 파일 공유를 지원할 때)');
    ok(await q(`!!document.querySelector('.bubble.media .save-chip.share') && !document.querySelector('.bubble.media .save-chip.share').hidden`), '동영상 말풍선에 공유 버튼이 있음');
    ok(await q(`[...document.querySelectorAll('.album-foot button')].map((b) => b.textContent).join(',')`) === '모두 저장,공유', '앨범 아래 줄에 "모두 저장 · 공유"');

    // 2) 문서 공유: 이름·형식·크기가 그대로 넘어감
    await click('.bubble.doc .share', 1); await sleep(700); // 데모의 견적서(src '#')는 건너뛰고, 방금 넣은 문서는 두 번째 문서 말풍선
    // (데모 견적서 문서가 첫 번째 .doc, 방금 넣은 계약서가 두 번째)
    let s = await shared();
    ok(s.length === 1 && s[0].length === 1 && s[0][0].name === '계약서.pdf' && s[0][0].type === 'application/pdf' && s[0][0].size === 9, `문서를 공유하면 같은 파일이 공유창으로 넘어감: ${JSON.stringify(s[0])}`);

    // 3) 동영상
    await click('.bubble.media .save-chip.share'); await sleep(700);
    s = await shared();
    ok(s.length === 2 && s[1][0].name === '회식.mp4' && s[1][0].type === 'video/mp4' && s[1][0].size === 12, `동영상도 공유됨: ${JSON.stringify(s[1])}`);

    // 4) 앨범: 사진 전부
    await click('.album-foot .foot-actions button', 1); await sleep(900);
    s = await shared();
    ok(s.length === 3 && s[2].length === 3 && s[2].map((f) => f.name).join(',') === 'IMG_2040.jpg,IMG_2041.jpg,IMG_2042.jpg', `앨범의 "공유"는 사진 3장을 한 번에 넘김: ${s[2]?.map((f) => f.name).join(',')}`);

    // 5) 크게 보기에서 한 장
    await q(`document.querySelectorAll('.bubble.album img')[1].click(); 1`); await sleep(300);
    ok(await q(`!document.getElementById('viewerShare').hidden`), '사진 크게 보기에 공유 버튼이 보임');
    await click('#viewerShare'); await sleep(700);
    s = await shared();
    ok(s.length === 4 && s[3].length === 1 && s[3][0].name === 'IMG_2041.jpg', `보고 있는 사진 한 장만 공유됨: ${JSON.stringify(s[3])}`);
    await q(`document.getElementById('viewerClose').click(); 1`);

    // 6) 받는 사이 "사용자 동작" 허용이 만료된 경우: 안내 → 한 번 더 누르면 바로 공유
    await addFile('큰파일.pdf', 'application/pdf', PDF2); await sleep(200);
    const nDoc = await q(`document.querySelectorAll('.bubble.doc .share').length`);
    await q(`window.__mode = 'expired'; 1`);
    await click('.bubble.doc .share', nDoc - 1); await sleep(700);
    ok((await toastText()).includes('한 번 더 눌러'), `허용이 만료되면 "한 번 더 눌러 주세요" 안내: "${await toastText()}"`);
    const before = (await shared()).length;
    await click('.bubble.doc .share', nDoc - 1); await sleep(500);
    s = await shared();
    ok(s.length === before + 1 && s[before][0].name === '큰파일.pdf', '두 번째 누름은 받아 둔 파일로 바로 공유됨');

    // 7) 취소 / 실패 / 형식 미지원
    await q(`window.__mode = 'abort'; document.getElementById('toast').textContent = ''; 1`);
    await click('.bubble.media .save-chip.share'); await sleep(500);
    ok(!(await toastText()).includes('못했어요') && (await shared()).length === before + 1, '공유창을 닫으면(취소) 아무 오류 안내도 없음');
    await q(`window.__mode = 'error'; 1`);
    await click('.bubble.media .save-chip.share'); await sleep(500);
    ok((await toastText()).includes('저장해서 보내'), `공유가 실패하면 저장 후 보내라고 안내: "${await toastText()}"`);
    await q(`window.__mode = 'cannot'; 1`);
    await click('.bubble.media .save-chip.share'); await sleep(500);
    ok((await toastText()).includes('공유할 수 없어요'), `지원하지 않는 파일이면 안내: "${await toastText()}"`);
    await q(`window.__mode = 'ok'; 1`);

    // 8) 대화를 지우면 받아 둔 파일 사본도 비움
    ok((await q(`shareCache.size`)) >= 4, `공유하려고 받아 둔 파일이 메모리에 있음 (${await q('shareCache.size')}개)`);
    await q(`clearList(); 1`);
    ok((await q(`shareCache.size`)) === 0, '대화를 지우면 받아 둔 파일 사본도 비워짐 (기록·잔류 없음)');

    // 8-2) 진짜 서버를 거친 파일: 폰이 올린 PDF 를 이 앱이 받아 공유창으로 넘기는 전체 경로 (파일 주소 fetch → File)
    const post2 = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
    const { key } = await post2('pair/start', {});
    const phone = await post2('join', { key, name: '휴대폰', device: 'share-phone' });
    await q(`localStorage.setItem('tt.key', ${JSON.stringify(key)}); localStorage.setItem('tt.device', 'share-pc'); localStorage.setItem('tt.name', 'PC'); 1`);
    await tab.call('Page.navigate', { url: `${B}/` }); await sleep(3500);
    const body = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(3000, 65)]);
    const up = await fetch(`${B}/api/upload?${new URLSearchParams({ token: phone.token, uid: 'share-real-1', offset: 0, total: body.length, name: 'real.pdf' })}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body });
    ok((await up.text()) === 'done', '폰(가짜)이 서버에 PDF 를 올림');
    for (let i = 0; i < 40 && !(await q(`!!document.querySelector('.bubble.doc .share')`)); i++) await sleep(150);
    ok(await q(`document.querySelector('.bubble.doc .doc-meta b')?.textContent`) === 'real.pdf', '이 앱에 받은 PDF 말풍선이 나타남');
    await click('.bubble.doc .share'); await sleep(1200);
    const real = (await shared()).pop();
    ok(real && real[0].name === 'real.pdf' && real[0].type === 'application/pdf' && real[0].size === body.length && real[0].head === '%PDF-1.4', `서버 파일 주소에서 받아 온 실제 파일이 그대로 공유창으로 넘어감: ${JSON.stringify(real?.[0])}`);
    await fetch(`${B}/api/leave?token=${phone.token}`, { method: 'POST' });

    // 9) 지원하지 않는 기기: 버튼이 모두 숨겨짐
    await tab.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: stub.result.identifier });
    // Edge(윈도우)는 실제로 파일 공유를 지원하므로, 지원하지 않는 기기는 canShare 가 false 인 것으로 흉내 낸다
    await tab.call('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });" });
    await open();
    await addFile('계약서.pdf', 'application/pdf', PDF); await addFile('회식.mp4', 'video/mp4', MP4); await sleep(300);
    ok(await q(`[...document.querySelectorAll('.share')].every((b) => b.hidden)`), '파일 공유를 지원하지 않는 기기에서는 문서·동영상 공유 버튼이 숨겨짐');
    ok(await q(`[...document.querySelectorAll('.album-foot button')].map((b) => b.textContent).join(',')`) === '모두 저장', '앨범 "공유" 버튼도 없음');
    await q(`document.querySelectorAll('.bubble.album img')[0].click(); 1`); await sleep(300);
    ok(await q(`document.getElementById('viewerShare').hidden`), '크게 보기의 공유 버튼도 숨겨짐');
  } catch (e) { console.log('ERROR', e); }
  tab.close();
  process.exit(0);
})();
