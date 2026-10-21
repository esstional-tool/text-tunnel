// md 문서의 코드 표시를 실제 코드 펼치기(<details>) 블록으로 바꾼다. 다시 실행하면 최신 코드로 갱신된다.
// 사용: node scripts/expand-code.js docs/learn/*.md
//
// 표시 쓰는 법 (md 안에 한 줄, 화면에는 안 보이는 HTML 주석):
//   <!-- code: server.js FROM "function replay" | 놓친 이벤트 다시 보내기 -->
//       → "function replay" 가 처음 나오는 줄부터 중괄호가 닫히는 줄까지
//   <!-- code: public/app.js FROM "async function uploadOne" TO "^}" | 재시도 루프 -->
//       → 시작 문구 줄부터, 그 뒤 TO 정규식에 맞는 첫 줄까지
//   <!-- code: extension/manifest.json | 확장 선언 -->        → 파일 전체
//   <!-- code: server.js LINES 10-20 | 설정 -->               → 줄 번호로 (줄이 밀리면 틀어지니 되도록 FROM 을 쓴다)
// 생성된 블록은 <!-- /code --> 까지이며, 다시 실행하면 그 사이를 새로 만든다.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

function braceEnd(lines, start) {
  let depth = 0, seen = false;
  for (let j = start; j < lines.length; j++) {
    // 문자열·템플릿·정규식 안의 괄호는 대충 걸러 낸다 (이 저장소 코드에는 충분)
    const code = lines[j].replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/.*$/g, '');
    for (const ch of code) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
    if (seen && depth <= 0) return j;
  }
  throw new Error('괄호가 닫히는 줄을 찾지 못함');
}

function render(spec, docFile) {
  const m = /^code:\s*(\S+)(?:\s+FROM\s+"([^"]+)"(?:\s+TO\s+"([^"]+)")?|\s+LINES\s+(\d+)-(\d+))?\s*(?:\|\s*(.+?))?\s*$/.exec(spec);
  if (!m) throw new Error('표시 형식 오류: ' + spec);
  const [, file, from, to, l1, l2, title = ''] = m;
  const lines = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  let a = 0, b = lines.length - 1;
  if (from) {
    a = lines.findIndex((l) => l.includes(from));
    if (a < 0) throw new Error(`${file} 에서 "${from}" 를 못 찾음`);
    b = to ? lines.findIndex((l, i) => i >= a && new RegExp(to).test(l)) : braceEnd(lines, a);
    if (b < 0) throw new Error(`${file} 에서 TO "${to}" 를 못 찾음`);
  } else if (l1) { a = Number(l1) - 1; b = Number(l2) - 1; }
  const whole = !from && !l1;
  const lang = { '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'md' }[path.extname(file)] || 'js';
  const rel = path.relative(path.dirname(docFile), path.join(root, file)).replace(/\\/g, '/');
  const range = whole ? '전체' : `${a + 1}–${b + 1}`;
  const link = whole ? rel : `${rel}#L${a + 1}-L${b + 1}`;
  return [
    '<details>',
    `<summary>📄 실제 코드 — <code>${file}</code> ${range}${title ? ' · ' + title : ''}</summary>`,
    '',
    `[GitHub에서 보기](${link})`,
    '',
    '```' + lang,
    lines.slice(a, b + 1).join('\n'),
    '```',
    '',
    '</details>',
  ].join('\n');
}

let total = 0;
for (const docFile of process.argv.slice(2)) {
  const abs = path.resolve(docFile);
  let doc = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  // 이미 만든 블록은 지우고 표시만 남긴 뒤 다시 만든다
  doc = doc.replace(/(<!-- (code:[^>]*?) -->)\n[\s\S]*?<!-- \/code -->/g, '$1');
  let n = 0;
  doc = doc.replace(/<!-- (code:[^>]*?) -->/g, (all, spec) => { n++; return `${all}\n${render(spec, abs)}\n<!-- /code -->`; });
  fs.writeFileSync(abs, doc);
  console.log(`${path.relative(root, abs)}: 코드 블록 ${n}개`);
  total += n;
}
if (!total) console.log('코드 표시가 없음. 사용법은 이 파일 맨 위 주석 참고');
