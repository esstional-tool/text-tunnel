// 사진 JPG 변환 시험 (이슈 #57): 서버 + Edge(--remote-debugging-port=9333) 를 띄운 뒤
//   node tests/jpg-convert.test.js http://localhost:8787
// 변환은 브라우저(app.js 의 toJpg)에서 일어나므로, 페이지 안에서 직접 호출해 결과를 확인한다.
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
    await sleep(2000);
    const r = await tab.evaluate(`(async () => {
      const out = {};
      // 1) 투명 배경 PNG → JPG, 투명한 곳은 흰색
      const c1 = document.createElement('canvas'); c1.width = 200; c1.height = 100;
      const g1 = c1.getContext('2d'); g1.fillStyle = 'rgba(255,0,0,0)'; g1.fillRect(0, 0, 200, 100); g1.fillStyle = '#00f'; g1.fillRect(100, 0, 100, 100);
      const png = await new Promise((ok) => c1.toBlob(ok, 'image/png'));
      const f1 = await toJpg(new File([png], 'clear.png', { type: 'image/png' }), false);
      out.f1 = { type: f1.type, name: f1.name };
      const bmp1 = await createImageBitmap(f1); const cc1 = document.createElement('canvas'); cc1.width = bmp1.width; cc1.height = bmp1.height;
      const x1 = cc1.getContext('2d'); x1.drawImage(bmp1, 0, 0); const left = x1.getImageData(10, 50, 1, 1).data;
      out.f1.leftWhite = left[0] > 240 && left[1] > 240 && left[2] > 240;
      // 2) 큰 사진 축소 (긴 변 2048 이하)
      const c2 = document.createElement('canvas'); c2.width = 4000; c2.height = 3000;
      const g2 = c2.getContext('2d'); for (let y = 0; y < 3000; y += 4) for (let x = 0; x < 4000; x += 4) { g2.fillStyle = 'rgb(' + ((x * 37 + y * 11) % 256) + ',' + ((x * 91 + y * 7) % 256) + ',' + ((x * 13 + y * 53) % 256) + ')'; g2.fillRect(x, y, 4, 4); } // 노이즈: 1.5MB 를 넘겨 축소 경로를 탄다
      const big = await new Promise((ok) => c2.toBlob(ok, 'image/jpeg', 0.95));
      const f2 = await toJpg(new File([big], 'big.jpg', { type: 'image/jpeg' }), false);
      const b2 = await createImageBitmap(f2);
      out.f2 = { type: f2.type, w: b2.width, h: b2.height };
      // 3) 원본 화질 + 작은 JPG → 그대로 (같은 객체)
      const small = new File([new Uint8Array([255, 216, 255, 217])], 'tiny.jpg', { type: 'image/jpeg' });
      out.same = (await toJpg(small, false)) === small;
      // 4) 원본 화질 켜면 크기는 그대로
      const f4 = await toJpg(new File([big], 'big.jpg', { type: 'image/jpeg' }), true);
      const b4 = await createImageBitmap(f4);
      out.f4 = { type: f4.type, w: b4.width };
      // 5) WebP → JPG
      const c5 = document.createElement('canvas'); c5.width = 50; c5.height = 50; c5.getContext('2d').fillStyle = '#0a0'; c5.getContext('2d').fillRect(0, 0, 50, 50);
      const webp = await new Promise((ok) => c5.toBlob(ok, 'image/webp'));
      const f5 = await toJpg(new File([webp], 'a.webp', { type: 'image/webp' }), false);
      out.f5 = { type: f5.type, name: f5.name };
      // 6) 읽을 수 없는 사진 (HEIC 흉내) → 안내 오류
      try { await toJpg(new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], 'IMG_0001.HEIC', { type: 'image/heic' }), false); out.heicError = null; }
      catch (e) { out.heicError = e.message; }
      return out; })()`);
    ok(r.f1.type === 'image/jpeg' && r.f1.name === 'clear.jpg', 'PNG 가 JPG 로 바뀌고 이름도 .jpg');
    ok(r.f1.leftWhite, '투명 배경은 흰색으로 깔림');
    ok(r.f2.type === 'image/jpeg' && Math.max(r.f2.w, r.f2.h) <= 2048 && Math.max(r.f2.w, r.f2.h) > 0, `큰 사진은 긴 변 2048 이하로 줄어듦 (${r.f2.w}x${r.f2.h})`);
    ok(r.same === true, '작은 JPG 는 그대로 (다시 그리지 않음)');
    ok(r.f4.type === 'image/jpeg' && r.f4.w === 4000, `원본 화질을 켜면 크기를 줄이지 않음 (${r.f4.w}px)`);
    ok(r.f5.type === 'image/jpeg' && r.f5.name === 'a.jpg', 'WebP 도 JPG 로 바뀜');
    ok(typeof r.heicError === 'string' && r.heicError.includes('JPEG'), `읽을 수 없는 사진은 안내 오류: "${r.heicError}"`);
  } catch (e) { console.log('ERROR', e); }
  try { tab?.close(); } catch {}
  process.exit(0);
})();
