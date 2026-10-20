// Text Tunnel 주소의 방문 기록과 캐시만 지운다. 다른 사이트 기록은 건드리지 않는다.
const ORIGINS = ['https://text-tunnel.onrender.com', 'http://localhost:8787'];

function isOurs(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'text-tunnel.onrender.com') return true;
    // 개발용 로컬 서버는 8787 포트만 (다른 localhost 개발 기록은 남긴다)
    return (u.hostname === 'localhost' || /^192\.168\./.test(u.hostname)) && u.port === '8787';
  } catch { return false; }
}

async function clean() {
  const seen = new Set();
  for (const text of ['text-tunnel', 'Text Tunnel', '8787']) {
    const items = await chrome.history.search({ text, startTime: 0, maxResults: 100000 });
    for (const it of items) if (isOurs(it.url) && !seen.has(it.url)) seen.add(it.url);
  }
  for (const url of seen) await chrome.history.deleteUrl({ url });
  // 연결 열쇠(localStorage)는 지우지 않는다. 지우면 QR로 다시 짝을 맺어야 해서
  await chrome.browsingData.remove({ origins: ORIGINS }, { cache: true, cacheStorage: true });
  await chrome.storage.local.set({ lastClean: Date.now() });
  return { count: seen.size };
}

// 자동 모드(기본 켜짐): 방문하는 즉시 그 기록을 지운다
chrome.history.onVisited.addListener(async (item) => {
  if (!isOurs(item.url)) return;
  const { auto = true } = await chrome.storage.local.get('auto');
  if (auto) chrome.history.deleteUrl({ url: item.url });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'clean') { clean().then(sendResponse, (e) => sendResponse({ error: String(e) })); return true; }
});
