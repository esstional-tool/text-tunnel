const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['auto', 'lastClean']).then(({ auto = true, lastClean }) => {
  $('auto').checked = auto;
  if (lastClean) $('result').textContent = `마지막으로 지운 시각: ${new Date(lastClean).toLocaleString('ko-KR')}`;
});

$('auto').onchange = (e) => chrome.storage.local.set({ auto: e.target.checked });

$('clean').onclick = async () => {
  $('clean').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'clean' });
  $('clean').disabled = false;
  $('result').textContent = r?.error ? `지우지 못했어요: ${r.error}` : `방문 기록 ${r.count}개와 캐시를 지웠어요`;
};
