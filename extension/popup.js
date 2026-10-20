const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['auto', 'lastClean', 'lastWipe']).then(({ auto = true, lastClean, lastWipe }) => {
  $('auto').checked = auto;
  const last = Math.max(lastClean || 0, lastWipe || 0);
  if (last) $('result').textContent = `마지막으로 지운 시각: ${new Date(last).toLocaleString('ko-KR')}`;
});
chrome.commands.getAll().then((cmds) => {
  const k = cmds.find((c) => c.name === 'wipe')?.shortcut;
  $('key').textContent = k || '단축키 없음 (chrome://extensions/shortcuts 에서 지정)';
});

$('auto').onchange = (e) => chrome.storage.local.set({ auto: e.target.checked });

$('clean').onclick = async () => {
  $('clean').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'clean' });
  $('clean').disabled = false;
  $('result').textContent = r?.error ? `지우지 못했어요: ${r.error}` : `기록 ${r.count}개, 다운로드 목록 ${r.downloads}개, 캐시를 지웠어요`;
};

let armed = false;
$('wipe').onclick = async () => {
  if (!armed) { armed = true; $('wipe').textContent = '한 번 더 누르면 완전 정리'; return; }
  $('wipe').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'wipe' });
  $('result').textContent = r?.error ? `정리하지 못했어요: ${r.error}` : `앱 ${r.closed}개를 닫고 기록 ${r.count}개, 다운로드 목록 ${r.downloads}개를 지웠어요`;
};
