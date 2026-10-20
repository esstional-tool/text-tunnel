// Text Tunnel 페이지와 확장 프로그램 사이의 연결고리.
// 페이지가 { source: 'tt-app', type: 'ping' | 'clean' } 을 보내면 확장이 응답한다.
const reply = async (m) => {
  const { auto = true } = await chrome.storage.local.get('auto');
  window.postMessage({ source: 'tt-ext', version: chrome.runtime.getManifest().version, auto, ...m }, location.origin);
};

window.addEventListener('message', async (e) => {
  if (e.source !== window || e.data?.source !== 'tt-app') return;
  if (e.data.type === 'ping') reply({ type: 'ready' });
  if (e.data.type === 'clean') reply({ type: 'cleaned', ...(await chrome.runtime.sendMessage({ type: 'clean' })) });
  if (e.data.type === 'auto') { await chrome.storage.local.set({ auto: !!e.data.on }); reply({ type: 'ready' }); }
});

reply({ type: 'ready' });
