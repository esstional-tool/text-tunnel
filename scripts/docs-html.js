// 저장소 문서를 GitHub 와 같은 모양의 HTML 파일로 만든다 (GitHub Markdown API 로 변환).
// 사용: node scripts/docs-html.js <저장소> <출력 폴더> [gh 경로]   (보통은 scripts/docs-pdf.js 가 부른다)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [root, out, gh = 'gh'] = process.argv.slice(2);
const REPO = 'esstional-tool/text-tunnel';
const BLOB = `https://github.com/${REPO}/blob/main/`;

const DOCS = [
  { src: 'README.md', out: 'index.html', title: 'README · 기능 목록' },
  { src: 'docs/WORKLOG.md', out: 'WORKLOG.html', title: '작업 내역' },
  { src: 'docs/ARCHITECTURE.md', out: 'ARCHITECTURE.html', title: '아키텍처 노트' },
  { src: 'docs/FLOWS.md', out: 'FLOWS.html', title: '흐름별 상세 해설' },
  { src: 'docs/STUDY.md', out: 'STUDY.html', title: '공부 로드맵' },
];
const OUT_OF = Object.fromEntries(DOCS.map((d) => [path.basename(d.src), d.out]));

// GitHub 식 제목 앵커: 소문자, 글자·숫자·공백·-·_ 외 제거, 공백 → -
function slugger() {
  const seen = {};
  return (text) => {
    let s = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = seen[s] = (seen[s] ?? -1) + 1;
    return n ? `${s}-${n}` : s;
  };
}
const stripTags = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function render(doc) {
  const src = path.join(root, doc.src);
  let html = execFileSync(gh, ['api', '-X', 'POST', 'markdown', '-F', `text=@${src}`, '-f', 'mode=gfm', '-f', `context=${REPO}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  // 1) GitHub 사이트에서만 그려지는 mermaid 자리 → 브라우저에서 mermaid.js 로 그리기
  html = html.replace(/<section[^>]*data-type="mermaid"[\s\S]*?<pre lang="mermaid"[^>]*>([\s\S]*?)<\/pre>[\s\S]*?<\/section>/g, (_, code) => `<pre class="mermaid">${code}</pre>`);

  // 2) 제목에 앵커 달기 (목차 링크용)
  const slug = slugger();
  html = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_, n, attrs, inner) => {
    const id = slug(stripTags(inner));
    return `<h${n}${attrs} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${n}>`;
  });

  // 3) 링크 고치기: 코드 파일 → GitHub, 다른 문서(.md) → 이 폴더의 .html
  html = html.replace(/href="([^"]+)"/g, (m, href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return m;
    const [p, frag = ''] = href.split('#');
    const base = path.basename(p);
    if (OUT_OF[base]) return `href="${OUT_OF[base]}${frag ? '#' + frag : ''}"`;
    const fromDir = path.posix.dirname(doc.src);
    const resolved = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, p));
    return `href="${BLOB}${resolved}${frag ? '#' + frag : ''}" target="_blank" rel="noopener"`;
  });
  return html;
}

function page(doc, body) {
  const nav = DOCS.map((d) => `<a href="${d.out}"${d === doc ? ' class="on"' : ''}>${d.title}</a>`).join('');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>text-tunnel · ${doc.title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.5.1/github-markdown.min.css">
<style>
  :root { --bar: #f6f8fa; --line: #d0d7de; --fg: #1f2328; --accent: #0969da; --page: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bar: #161b22; --line: #30363d; --fg: #e6edf3; --accent: #4493f8; --page: #0d1117; } }
  html, body { margin: 0; background: var(--page); }
  .bar { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 10px 24px; background: var(--bar); border-bottom: 1px solid var(--line); font: 14px/1.4 -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }
  .bar nav { display: flex; flex-wrap: wrap; gap: 4px 14px; flex: 1; }
  .bar a { color: var(--fg); text-decoration: none; }
  .bar a.on { color: var(--accent); font-weight: 600; }
  .bar button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--page); color: var(--fg); cursor: pointer; }
  .markdown-body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 32px 24px 64px; }
  .markdown-body details { margin: 8px 0; border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; }
  .markdown-body details > summary { cursor: pointer; }
  .markdown-body details[open] > summary { margin-bottom: 8px; }
  .markdown-body pre.mermaid { background: transparent; text-align: center; }
  .markdown-body h1 .anchor, .markdown-body h2 .anchor, .markdown-body h3 .anchor { float: left; margin-left: -20px; padding-right: 4px; opacity: 0; text-decoration: none; }
  .markdown-body :is(h1,h2,h3):hover .anchor { opacity: .6; }
  @media (max-width: 640px) { .markdown-body { padding: 20px 16px 48px; } }
  @media print {
    .bar { display: none; }
    .markdown-body { max-width: none; padding: 0; }
    .markdown-body details { break-inside: auto; }
    .markdown-body pre { white-space: pre-wrap; word-break: break-word; }
    .markdown-body h1, .markdown-body h2 { break-after: avoid; }
  }
</style>
</head>
<body>
<div class="bar">
  <nav>${nav}</nav>
  <button type="button" onclick="setAll(true)">모두 펼치기</button>
  <button type="button" onclick="setAll(false)">모두 접기</button>
</div>
<article class="markdown-body">
${body}
</article>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script>
  function setAll(open) { document.querySelectorAll('details').forEach((d) => { d.open = open; }); }
  // 인쇄할 때와 ?print 로 열었을 때는 코드를 모두 펼친다
  addEventListener('beforeprint', () => setAll(true));
  if (location.search.includes('print')) setAll(true);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && !location.search.includes('print');
  mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
</script>
</body>
</html>
`;
}

fs.mkdirSync(out, { recursive: true });
for (const doc of DOCS) {
  const html = page(doc, render(doc));
  fs.writeFileSync(path.join(out, doc.out), html);
  const mermaids = (html.match(/<pre class="mermaid">/g) || []).length;
  const details = (html.match(/<details>/g) || []).length;
  console.log(`${doc.out.padEnd(18)} ${Math.round(html.length / 1024)}KB  다이어그램 ${mermaids}  코드 펼치기 ${details}`);
}
