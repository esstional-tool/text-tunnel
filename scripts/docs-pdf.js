// 문서(README·docs/*.md)를 GitHub 모양 그대로 PDF 로 만들어 docs/pdf/ 에 저장한다.
// GitHub 파일 화면은 인쇄하면 본문이 비어서, 인쇄용 PDF 를 저장소에 같이 둔다.
// 중간 HTML 은 임시 폴더에 만들고 끝나면 지운다 (PC 에 남기지 않음).
//
// 필요한 것: gh(GitHub CLI, 로그인 상태 — GitHub Markdown API 로 변환), Microsoft Edge, 인터넷(스타일·mermaid CDN)
// 사용: node scripts/docs-pdf.js            (저장소 루트에서)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'pdf');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-docs-'));
const gh = process.env.GH || 'gh';
const edge = [
  process.env.EDGE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!edge) throw new Error('Microsoft Edge 를 찾지 못했어요. EDGE 환경변수로 경로를 지정하세요');

const PAGES = [['index', 'README'], ['WORKLOG', 'WORKLOG'], ['ARCHITECTURE', 'ARCHITECTURE'], ['FLOWS', 'FLOWS'], ['STUDY', 'STUDY']];

try {
  // 1) GitHub 모양 HTML (임시 폴더)
  execFileSync(process.execPath, [path.join(__dirname, 'docs-html.js'), root, path.join(tmp, 'html'), gh], { stdio: 'inherit' });
  // 2) Edge 로 인쇄 (?print 로 열면 코드 펼치기가 모두 열린 상태, mermaid 는 밝은 테마)
  fs.mkdirSync(outDir, { recursive: true });
  for (const [html, pdf] of PAGES) {
    const url = 'file:///' + path.join(tmp, 'html', `${html}.html`).replace(/\\/g, '/') + '?print=1';
    execFileSync(edge, ['--headless=new', '--disable-gpu', `--user-data-dir=${path.join(tmp, 'edge')}`, '--no-pdf-header-footer',
      '--virtual-time-budget=15000', `--print-to-pdf=${path.join(outDir, `${pdf}.pdf`)}`, url], { stdio: 'ignore' });
    console.log(`docs/pdf/${pdf}.pdf  ${Math.round(fs.statSync(path.join(outDir, `${pdf}.pdf`)).size / 1024)}KB`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true }); // 중간 파일 삭제
}
