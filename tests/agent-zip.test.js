// 에이전트 받기(zip)와 자동 실행 시험 (이슈 #30) — Windows 전용. 서버를 띄운 뒤
//   node tests/agent-zip.test.js http://localhost:8787
// 1) 서버가 주는 zip 의 내용·CRC·서버 주소 반영·비밀 없음·Host 헤더 주입 방어
// 2) 압축을 풀어 **그대로 빌드**되는지 (진짜 컴파일 — zip 만으로 완결되는지)
// 3) 진짜 에이전트의 "Windows 시작 시 자동 실행" 등록/삭제 (시험용 이름 --run-key-name 을 써서 사용자의 실제 설정은 건드리지 않는다)
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2];
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${B}/api/${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ ...(await r.json().catch(() => ({}))), status: r.status }));

function get(p, headers = {}) {
  const u = new URL(B);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
// 최소 ZIP 해석 (저장만 하는 형식): 중앙 디렉터리를 읽어 항목마다 로컬 헤더의 데이터를 꺼내고 CRC 를 확인한다
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10); let o = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    const crc = buf.readUInt32LE(o + 16), size = buf.readUInt32LE(o + 24), nl = buf.readUInt16LE(o + 28), el = buf.readUInt16LE(o + 30), cl = buf.readUInt16LE(o + 32), lo = buf.readUInt32LE(o + 42);
    const name = buf.subarray(o + 46, o + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(lo + 26), lel = buf.readUInt16LE(lo + 28);
    const data = buf.subarray(lo + 30 + lnl + lel, lo + 30 + lnl + lel + size);
    out.push({ name, data, crcOk: crc32(data) === crc });
    o += 46 + nl + el + cl;
  }
  return out;
}

(async () => {
  // ── 1) zip 내용 ──────────────────────────────────
  const r = await get('/text-tunnel-agent.zip');
  ok(r.status === 200 && r.headers['content-type'] === 'application/zip' && /attachment; filename="text-tunnel-agent.zip"/.test(r.headers['content-disposition']), '에이전트 zip 을 내려받을 수 있음 (첨부 파일)');
  const files = unzip(r.body);
  const names = files.map((f) => f.name).sort();
  ok(JSON.stringify(names) === JSON.stringify(['text-tunnel-agent/Program.cs', 'text-tunnel-agent/build-agent.cmd', 'text-tunnel-agent/run-agent.cmd', 'text-tunnel-agent/읽어보세요.txt'].sort()), `들어 있는 파일: ${names.map((x) => x.split('/')[1]).join(', ')}`);
  ok(files.every((f) => f.crcOk), '모든 파일의 CRC 가 맞음 (손상 없음)');
  const by = (n) => files.find((f) => f.name.endsWith('/' + n))?.data;
  ok(by('Program.cs').equals(fs.readFileSync(path.join(__dirname, '..', 'agent', 'Program.cs'))), 'Program.cs 가 저장소의 에이전트 소스와 같음 (항상 최신)');
  const crlfOnly = (t) => t.includes('\r\n') && !/[^\r]\n/.test(t);
  ok(crlfOnly(by('build-agent.cmd').toString('utf8')) && crlfOnly(by('run-agent.cmd').toString('utf8')), '.cmd 파일은 줄 끝이 모두 CRLF (리눅스 서버에서도 윈도우에서 돌아가게)');
  const run = by('run-agent.cmd').toString('utf8');
  ok(run.includes(`remote-agent.exe --server ${B} %*`) && run.includes('build-agent.cmd'), `run-agent.cmd 에 이 서버 주소가 들어가고 없으면 빌드함 (${B})`);
  const all = files.map((f) => f.data.toString('utf8')).join('\n');
  ok(!/[A-Za-z0-9_-]{43}/.test(run) && !/[A-Za-z0-9_-]{43}/.test(by('읽어보세요.txt').toString('utf8')) && !/pin\.dat|key\.txt/.test(run), '스크립트·안내문에 열쇠·PIN 같은 비밀이 없음');
  ok(by('읽어보세요.txt').toString('utf8').startsWith('\ufeff') && /접속 PIN 설정/.test(all), '안내문(UTF-8)에 PIN 설정 순서가 있음');

  // 서버 주소는 .cmd 에 들어가므로 Host 헤더 주입을 막아야 한다
  const evil = unzip((await get('/text-tunnel-agent.zip', { host: 'a&calc.exe' })).body).find((f) => f.name.endsWith('run-agent.cmd')).data.toString('utf8');
  ok(!evil.includes('calc') && !evil.includes('--server'), '이상한 Host 헤더(& 등)는 서버 주소로 쓰지 않음 (명령 주입 방어)');
  const https = unzip((await get('/text-tunnel-agent.zip', { 'x-forwarded-proto': 'https', host: 'text-tunnel.onrender.com' })).body).find((f) => f.name.endsWith('run-agent.cmd')).data.toString('utf8');
  ok(https.includes('--server https://text-tunnel.onrender.com '), '프록시 뒤(https)에서는 https 주소가 들어감');

  // ── 2) 압축을 풀어 그대로 빌드 ──────────────────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-zip-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f.name.split('/')[1]), f.data);
  const b = spawnSync('C:\\Windows\\System32\\cmd.exe', ['/c', path.join(dir, 'build-agent.cmd')], { cwd: dir, encoding: 'utf8' });
  ok(b.status === 0 && fs.existsSync(path.join(dir, 'remote-agent.exe')) && /BUILD OK/.test(b.stdout), `zip 만으로 빌드됨 (${(b.stdout || '').trim().split('\n').pop()})`);

  // ── 3) 자동 실행 등록/삭제 ──────────────────────────
  const exe = path.join(dir, 'remote-agent.exe');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-auto-'));
  const name = 'tt-test-' + Math.random().toString(36).slice(2, 8);
  const reg = () => execFileSync(PS, ['-NoProfile', '-Command', `$v=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'${name}'; if($v){$v}else{'(none)'}`], { encoding: 'utf8' }).trim();
  let a;
  try {
    ok(reg() === '(none)', '시험용 자동 실행 항목이 처음에는 없음');
    const pair = await post('pair/start', {});
    a = spawn(exe, ['--server', B, '--config', cfg, '--code', pair.code, '--set-pin', '482915', '--quiet', '--autostart', 'on', '--run-key-name', name], { stdio: 'ignore' });
    await sleep(2500);
    const v = reg();
    ok(v.includes(exe) && v.includes(`--server "${B}"`) && v.includes(`--config "${cfg}"`), `--autostart on → 시작 프로그램에 등록됨 (실행 파일·서버·설정 폴더 포함): ${v.slice(0, 120)}`);
    ok(!/--code|--set-pin|482915/.test(v), '등록된 명령에 짝 코드·PIN 은 들어 있지 않음');
    ok(/자동 실행을 켰어요/.test(fs.readFileSync(path.join(cfg, 'access.log'), 'utf8')), '접속 기록에 자동 실행 켬이 남음');
    a.kill(); await sleep(1500);
    a = spawn(exe, ['--server', B, '--config', cfg, '--quiet', '--autostart', 'off', '--run-key-name', name], { stdio: 'ignore' });
    await sleep(2500);
    ok(reg() === '(none)', '--autostart off → 시작 프로그램에서 삭제됨');
  } catch (e) { console.log('ERROR', e); }
  try { a?.kill(); } catch {}
  try { execFileSync(PS, ['-NoProfile', '-Command', `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${name}' -ErrorAction SilentlyContinue`]); } catch { /* 이미 없으면 오류 코드 1 */ }
  ok(reg() === '(none)', '시험이 끝나고 시험용 항목을 정리함 (사용자의 실제 자동 실행 설정은 건드리지 않음)');
  process.exit(0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
