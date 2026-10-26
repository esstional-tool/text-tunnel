// 고른 사진·파일 붙잡기 시험 (이슈 #40) — 실제 Edge(헤드리스, 원격 디버깅 9333). 서버를 띄운 뒤
//   node tests/pick.test.js http://localhost:8787
// 안드로이드에서 "고른 뒤 보내기 전에 파일을 못 읽게 되는" 상황(삭제·이동·클라우드에만 있음)을, 읽기가 NotFoundError 로 실패하는 가짜 파일로 흉내 낸다.
const B = process.argv[2], D = 'http://127.0.0.1:9333';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, evaluate: async (expr) => { const r = (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result; return r?.exceptionDetails ? 'EXC ' + r.exceptionDetails.exception?.description : r?.result?.value; }, close: () => ws.close() };
}

(async () => {
  const t = await (await fetch(`${D}/json/new?about:blank`, { method: 'PUT' })).json();
  const tab = await cdp(t.webSocketDebuggerUrl);
  await tab.call('Page.enable');
  await tab.call('Page.navigate', { url: `${B}/#demo-chat` }); await sleep(300); await tab.call('Page.reload'); await sleep(1600);
  const q = (js) => tab.evaluate(js);
  // 시험용 파일: 정상 사진·문서, 읽기가 실패하는 사진·문서
  await q(`
    window.mk = (name, type, text) => new File([text], name, { type });
    window.gone = () => Promise.reject(new DOMException('A requested file or directory could not be found', 'NotFoundError'));
    window.goodImg = mk('정상.jpg', 'image/jpeg', 'JPEGDATA-0123456789');
    window.goodDoc = mk('정상.pdf', 'application/pdf', '%PDF-1.4 hello');
    window.badImg = mk('사라진사진.jpg', 'image/jpeg', 'x'); badImg.arrayBuffer = gone;
    window.badDoc = mk('사라진문서.pdf', 'application/pdf', 'x'); badDoc.slice = () => ({ arrayBuffer: gone });
    tray.length = 0; 1`);

  await q(`READ_RETRY_MS.length = 0; READ_RETRY_MS.push(30, 30, 30); 1`); // 시험에서는 기다림을 짧게 (실제는 0.6·1.2·2초)

  // 0) 처음 두 번은 못 읽다가 세 번째에 읽히는 사진(카메라가 아직 저장 중)은 포기하지 않고 결국 포함한다
  await q(`window.flaky = mk('저장중.jpg', 'image/jpeg', 'LATE-OK'); let n = 0; const real = flaky.arrayBuffer.bind(flaky); flaky.arrayBuffer = () => (++n <= 2 ? gone() : real()); window.flakyReads = () => n; 1`);
  const tw = Date.now();
  await q(`addToTray([flaky, goodDoc])`);
  ok((await q(`tray.map((t) => t.file.name).join(',')`)) === '저장중.jpg,정상.pdf' && (await q(`flakyReads()`)) === 3, `처음 두 번 실패해도 다시 읽어 결국 포함 (읽기 ${await q('flakyReads()')}번, ${Date.now() - tw}ms, 순서 유지)`);
  ok(!(await q(`document.getElementById('toast').textContent`)).includes('뺐어요'), '결국 읽혔으니 "뺐어요" 안내는 없음');
  await q(`tray.length = 0; 1`);
  // 정상 파일은 기다림 없이 바로 올라간다
  const tf = Date.now();
  await q(`addToTray([goodImg2 = mk('빠름.jpg', 'image/jpeg', 'FAST')])`);
  ok(Date.now() - tf < 25 && (await q(`tray.length`)) === 1, `정상 사진은 지연 없이 바로 올라감 (${Date.now() - tf}ms)`);
  await q(`tray.length = 0; 1`);

  // 1) 끝까지 읽을 수 없는 것만 고르는 순간 알리고 뺀다
  await q(`addToTray([goodImg, badImg, badDoc, goodDoc])`);
  ok((await q(`tray.length`)) === 2 && (await q(`tray.map((t) => t.file.name).join(',')`)) === '정상.jpg,정상.pdf', `읽을 수 없는 사진·문서는 빼고 정상인 2개만 미리보기에 올림: ${await q(`tray.map((t) => t.file.name).join(',')`)}`);
  const toast = await q(`document.getElementById('toast').textContent`);
  ok(toast.includes('2개는 읽을 수 없어 뺐어요') && toast.includes('사라진사진.jpg'), `어떤 파일이 왜 빠졌는지 알려 줌: "${toast}"`);

  // 2) 사진은 고르는 순간 복사본을 들고 있으므로, 원본이 나중에 사라져도 보낼 수 있다
  ok(await q(`tray[0].file !== goodImg && tray[0].file.size === goodImg.size && tray[0].file.type === 'image/jpeg' && tray[0].file.name === '정상.jpg'`), '사진은 내용을 복사한 새 파일을 들고 있음 (이름·형식·크기 그대로)');
  await q(`goodImg.arrayBuffer = gone; goodImg.slice = () => ({ arrayBuffer: gone }); 1`); // 원본이 사라졌다고 가정
  ok((await q(`tray[0].file.arrayBuffer().then((b) => new TextDecoder().decode(b))`)) === 'JPEGDATA-0123456789', '원본이 사라진 뒤에도 복사본은 내용을 그대로 읽을 수 있음');

  // 3) 실제 입력칸 흐름: 앱이 change 직후 입력칸 value 를 비워도(= 살아 있는 FileList 가 비워져도) 고른 파일이 유지됨
  await q(`tray.length = 0; (() => { const dt = new DataTransfer(); dt.items.add(mk('입력칸.jpg', 'image/jpeg', 'ABCDEF')); const inp = document.getElementById('pickMedia'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); return inp.files.length; })()`);
  await sleep(300);
  ok((await q(`tray.length`)) === 1 && (await q(`tray[0].file.name`)) === '입력칸.jpg', '입력칸이 change 직후 비워져도 고른 사진이 미리보기에 남음');

  // 4) 보내는 중 읽기가 실패하면: 재시도(약 31초) 없이 바로 이유를 알림
  await q(`window.__realPostChunk = postChunk; window.postChunk = async () => ({ status: 0, text: '', size: 0 }); 1`); // 업로드가 "연결 끊김"처럼 실패
  const t0 = Date.now();
  const res = await q(`(async () => { let retries = 0; const f = mk('중간에사라짐.jpg', 'image/jpeg', 'abc'); f.slice = () => ({ arrayBuffer: gone }); try { await uploadOne(f, null, () => {}, () => retries++); return 'resolved'; } catch (e) { return JSON.stringify({ msg: e.message, retries }); } })()`);
  const r1 = JSON.parse(res);
  ok(r1.msg.includes('파일을 읽을 수 없어요') && r1.retries === 0 && Date.now() - t0 < 1500, `읽을 수 없는 파일은 재시도 없이 바로 이유를 알림: ${res} (${Date.now() - t0}ms)`);
  // 5) 파일은 멀쩡한데 연결만 끊긴 경우는 예전처럼 다시 시도한다
  const res2 = await q(`(async () => { let retries = 0; const f = mk('멀쩡.jpg', 'image/jpeg', 'abc'); uploadOne(f, null, () => {}, () => retries++).catch(() => {}); await new Promise((r) => setTimeout(r, 1200)); return retries; })()`);
  ok(res2 === 1, `읽을 수 있는 파일의 연결 끊김은 기존대로 다시 시도함 (재시도 ${res2}번 시작)`);
  // 6) 진짜 서버로 끝까지: 고른 사진(복사본)이 실제로 올라가 상대 기기에 도착한다
  const post2 = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  const { key } = await post2('pair/start', {});
  const phone = await post2('join', { key, name: '휴대폰', device: 'pick-phone' });
  const seen = []; const ac = new AbortController();
  fetch(`${B}/api/events?token=${phone.token}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) seen.push(JSON.parse(d)); } }
  }).catch(() => {});
  await tab.call('Page.navigate', { url: `${B}/` }); await sleep(500);
  await q(`localStorage.setItem('tt.key', ${JSON.stringify(key)}); localStorage.setItem('tt.device', 'pick-pc'); localStorage.setItem('tt.name', 'PC'); 1`);
  await tab.call('Page.reload'); await sleep(3500);
  await q(`(async () => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); const src = new File([png], 'E2E.png', { type: 'image/png' }); await addToTray([src]); src.arrayBuffer = () => Promise.reject(new DOMException('gone', 'NotFoundError')); src.slice = () => ({ arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotFoundError')) }); sendFiles(tray.map((t) => t.file), true); return tray.length; })()`);
  for (let i = 0; i < 40 && !seen.some((m) => m.type === 'file'); i++) await sleep(250);
  const got = seen.find((m) => m.type === 'file');
  ok(!!got && got.fname === 'E2E.png' && got.mime === 'image/png', `원본이 사라진 뒤에도 복사본이 실제로 업로드되어 상대 기기에 도착: ${JSON.stringify(got && { fname: got.fname, mime: got.mime, size: got.size })}`);
  ac.abort(); await fetch(`${B}/api/leave?token=${phone.token}`, { method: 'POST' });
  tab.close();
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
