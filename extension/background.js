// Text Tunnel 의 흔적(방문 기록·관련 검색 기록·다운로드 목록·캐시)을 지우고, 단축키로 완전히 정리한다.
// 다른 사이트 기록과 다른 검색어는 건드리지 않는다.
const ORIGINS = ['https://text-tunnel.onrender.com', 'http://localhost:8787'];
const TAB_URLS = ['https://text-tunnel.onrender.com/*', 'http://localhost/*'];

function isOurs(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'text-tunnel.onrender.com') return true;
    // 개발용 로컬 서버는 8787 포트만 (다른 localhost 개발 기록은 남긴다)
    return (u.hostname === 'localhost' || /^192\.168\./.test(u.hostname)) && u.port === '8787';
  } catch { return false; }
}

// 검색엔진 결과 페이지 중 검색어에 Text Tunnel 이 들어간 것만
const SEARCH_HOST = /(^|\.)google\.[a-z.]+$|(^|\.)bing\.com$|^search\.naver\.com$|^m\.search\.naver\.com$|^search\.daum\.net$|^m\.search\.daum\.net$/;
const OUR_TERMS = /text[\s\-_+.]*tunnel|onrender/i;
function isOurSearch(url) {
  try {
    const u = new URL(url);
    if (!SEARCH_HOST.test(u.hostname)) return false;
    const q = u.searchParams.get('q') || u.searchParams.get('query') || '';
    return OUR_TERMS.test(q);
  } catch { return false; }
}
const shouldDelete = (url) => isOurs(url) || isOurSearch(url);

async function deleteHistory() {
  const seen = new Set();
  for (const text of ['text-tunnel', 'Text Tunnel', 'text tunnel', 'tunnel', 'onrender', '8787']) {
    const items = await chrome.history.search({ text, startTime: 0, maxResults: 100000 });
    for (const it of items) if (shouldDelete(it.url)) seen.add(it.url);
  }
  for (const url of seen) await chrome.history.deleteUrl({ url });
  return seen.size;
}

// 다운로드 목록에서만 뺀다 (받은 파일은 그대로)
async function eraseDownloads() {
  const erased = await chrome.downloads.erase({ urlRegex: 'text-tunnel\\.onrender\\.com|localhost:8787' }).catch(() => []);
  return erased.length;
}

// 방문 기록·검색 기록·다운로드 목록 + 캐시. 연결 열쇠(localStorage)는 지우지 않는다 (다시 짝 맺을 필요 없게)
async function clean() {
  const count = await deleteHistory();
  const downloads = await eraseDownloads();
  await chrome.browsingData.remove({ origins: ORIGINS }, { cache: true, cacheStorage: true });
  await chrome.storage.local.set({ lastClean: Date.now() });
  return { count, downloads };
}

// 완전 정리: 열린 앱에 대화 지우기·연결 해제를 시키고, 창을 닫고, 사이트 데이터·캐시·기록을 모두 지운다
async function wipe() {
  const tabs = (await chrome.tabs.query({ url: TAB_URLS })).filter((t) => isOurs(t.url));
  await Promise.all(tabs.map((t) => Promise.race([
    chrome.tabs.sendMessage(t.id, { type: 'wipe' }).catch(() => null),
    new Promise((ok) => setTimeout(ok, 1500)), // 응답이 늦어도 정리는 계속한다
  ])));
  await Promise.all(tabs.map((t) => chrome.tabs.remove(t.id).catch(() => null)));
  await chrome.browsingData.remove({ origins: ORIGINS }, {
    cache: true, cacheStorage: true, cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true, fileSystems: true,
  });
  const count = await deleteHistory();
  const downloads = await eraseDownloads();
  await chrome.storage.local.set({ lastWipe: Date.now() });
  return { count, downloads, closed: tabs.length };
}

async function shortcut() {
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'wipe');
  return cmd?.shortcut || '';
}

chrome.commands.onCommand.addListener((name) => { if (name === 'wipe') wipe(); });

// 자동 모드(기본 켜짐): 앱 방문이나 관련 검색을 하는 즉시 그 기록을 지운다
chrome.history.onVisited.addListener(async (item) => {
  if (!shouldDelete(item.url)) return;
  const { auto = true } = await chrome.storage.local.get('auto');
  if (auto) chrome.history.deleteUrl({ url: item.url });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = { clean, wipe, info: async () => ({ shortcut: await shortcut() }) }[msg?.type];
  if (!run) return;
  run().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
