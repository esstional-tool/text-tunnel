// Text Tunnel 페이지와 확장 프로그램 사이의 연결고리.
// 페이지 → 확장: { source: 'tt-app', type: 'ping' | 'clean' | 'wipe' | 'auto' }
// 확장 → 페이지: { source: 'tt-ext', type: 'ready' | 'cleaned' | 'wipe' }
const post = (m) => window.postMessage({ source: 'tt-ext', ...m }, location.origin);
const reply = async (m) => {
  const { auto = true } = await chrome.storage.local.get('auto');
  const { shortcut = '' } = (await chrome.runtime.sendMessage({ type: 'info' }).catch(() => null)) || {};
  post({ version: chrome.runtime.getManifest().version, auto, shortcut, ...m });
};

window.addEventListener('message', async (e) => {
  if (e.source !== window || e.data?.source !== 'tt-app') return;
  if (e.data.type === 'ping') reply({ type: 'ready' });
  if (e.data.type === 'clean') reply({ type: 'cleaned', ...(await chrome.runtime.sendMessage({ type: 'clean' })) });
  if (e.data.type === 'wipe') chrome.runtime.sendMessage({ type: 'wipe' }); // 이 탭도 닫힌다
  if (e.data.type === 'auto') { await chrome.storage.local.set({ auto: !!e.data.on }); reply({ type: 'ready' }); }
});

// 단축키로 완전 정리할 때: 페이지가 대화 지우기·연결 해제를 마칠 때까지 잠깐 기다린다
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'wipe') return;
  const done = (e) => {
    if (e.source !== window || e.data?.source !== 'tt-app' || e.data.type !== 'wiped') return;
    window.removeEventListener('message', done);
    sendResponse({ ok: true });
  };
  window.addEventListener('message', done);
  post({ type: 'wipe' });
  return true;
});

reply({ type: 'ready' });
