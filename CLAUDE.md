# text-tunnel

DB 없이 내 PC와 휴대폰을 QR 로 한 번 짝지어 두고 텍스트·사진·동영상·파일을 주고받는 개인용 메신저(PWA). 자세한 것은 `README.md`, 구조는 `docs/ARCHITECTURE.md`, 흐름은 `docs/FLOWS.md`.

## dev-cycle 설정

> 개발 흐름 스킬(`esstional-tool/claude-skills` 의 dev-cycle 등)이 이 칸을 먼저 읽는다. 스킬 기본값과 다르면 여기가 이긴다.

| 항목 | 값 |
|---|---|
| 한 줄 소개 | PC ↔ 휴대폰 2대 전용 실시간 메신저. Node 서버 하나 + 바닐라 JS PWA + 흔적 지우기 브라우저 확장 |
| 지켜야 할 원칙 | **DB·외부 저장소·외부 SaaS 금지** (Supabase·Pusher 등 제안하지 않기) · **기록 안 남김** — 디스크·로그에 대화·열쇠·방 이름을 쓰지 않음, 보관은 메모리에 짧게(파일 10분, 놓친 메시지 2분) · **의존성 0** (Node 기본 모듈만, 화면도 프레임워크 없음) · 최대 2대 |
| GitHub | `esstional-tool/text-tunnel` (Public, 2026-10-23 전환 — 새로 올리는 파일에 비밀값·회사 정보·개인 정보를 넣지 말 것) |
| 기본 브랜치 | main |
| 병합 정책 | 사용자가 "확정 / 합쳐 / 다 해줘" 했을 때만. **병합 = Render 자동 재배포** → 열려 있던 앱 연결이 잠깐 끊김 |
| 배포 | Render (무료, Web Service) — 플랫폼 참고서 `deploy-check/platforms/render.md` |
| 실서비스 주소 | https://text-tunnel.onrender.com |
| 배포 반영 확인 | `/app.js` (화면 변경) 또는 새 API 응답 (서버 변경) 에 이번 변경의 고유 문자열 — 보통 20~35초 |
| 로컬 실행 | `node server.js` → http://localhost:8787 (Windows `start.cmd`). 휴대폰은 같은 와이파이에서 `http://<PC IP>:8787` |
| 원격조종 시험 | `REMOTE_AUTH_TIMEOUT_SEC=2` 로 띄워 `remote`(51) · 기본으로 `remote-quality`(15) `remote-patch`(36) `remote-control`(32) · **Windows 전용(진짜 exe, `agentuild-agent.cmd` 먼저)**: `remote-agent`(32) `remote-dirty`(22) `remote-adapt`(13) `remote-control-agent`(1부 28 + 2부는 입력 주입이 막힌 환경이면 SKIP) · Edge(`--remote-debugging-port=9333`) 필요: `remote-ui`(38) `remote-host-ui`(14) `share`(21, 앱의 파일 공유) `pick`(11, 고른 파일 붙잡기 — Edge 필요, 서버만) · 서버만 `agent-zip`(17, Windows: 압축 풀어 빌드·레지스트리 자동 실행, 시험용 이름 `--run-key-name`). **`pair` 는 반드시 마지막**(IP 10분 차단 → 짝 코드 못 받음). 에이전트 시험용 옵션: `--fake-screen <폴더>`(합성 화면) `--input-sink <파일>`(입력을 파일에 기록) |
| 시험 명령 | 서버를 `PORT=8787 STALE_SEC=3 REPLAY_SEC=3 node server.js` 로 띄우고 `tests/pair.test.js` (16) · `tests/rejoin.test.js` (6, STALE_SEC=3 필요) · `tests/replay.test.js` (10, REPLAY_SEC=3 필요) · `tests/upload.test.js` (9) — 각각 `node tests/<이름>.test.js http://localhost:8787` |
| 실서버에서 끌 시험 | `SKIP_RL=1` (틀린 코드 반복 → 내 IP 10분 차단) · `SKIP_EXPIRY=1` (보관 2분 만료) · `rejoin.test.js` 는 실서버에서 생략 (STALE_SEC 를 못 바꿈) |
| 브라우저 시험 | 데모 장면(서버 없이): `/#demo` `/#demo-<welcome·code·qr·install-android·install-ios·wait·chat·attach·tray·viewer·ext·ext-on>` · 짝 맺은 상태로 열기: `localStorage` 에 `tt.key`(pair/start 로 받은 열쇠)·`tt.device`·`tt.name` 을 넣고 새로고침 · 페이지 최상위 함수(`sendFiles`, `joinRoom`, `connect` 등)를 CDP 로 직접 호출 가능 |
| 갱신할 문서 | `README.md` 기능 목록·환경변수·시험 · `docs/WORKLOG.md` 진행 이력 표(병합 시각은 gh 로)·겪은 문제 표·시험 기록 표 · `docs/learn/` 학습 노트 + 목차 · 코드 블록 갱신 `node scripts/expand-code.js docs/learn/*.md` · 인쇄용 PDF `GH=<gh 경로> node scripts/docs-pdf.js` |
| 학습 노트 | 예 (작업마다) |

## 이 프로젝트만의 함정

- **확장 프로그램 대상 포트는 8787 만**: `extension/background.js` 의 `isOurs` 가 다른 localhost 개발 기록을 지우지 않으려고 8787 만 본다 → 확장 시험은 반드시 8787 서버로 (8799 로 했다가 거짓 실패).
- **확장 버전 올릴 때**: `extension/manifest.json` 의 `version` 과 `public/app.js` 의 `EXT_LATEST` 를 같이 올린다. 확장은 자동 업데이트가 안 됨(개발자 모드) → 사용자에게 zip 재설치 안내. 사용자 엣지의 완전 정리 단축키는 **Ctrl+Shift+8** (9 는 다른 프로그램과 충돌).
- **사용자 PC 앱은 엣지로 설치됨** — 크롬에만 확장을 깔면 동작 안 함.
- 서버 시작 시 `extension/` 을 zip 으로 묶어 `/text-tunnel-cleaner.zip` 으로 내려준다 — 확장 파일을 고치면 서버 재시작(배포)으로 zip 도 갱신.
- `docs/` 의 📄 코드 블록은 **2026-10-20 시점 사본** (ARCHITECTURE·FLOWS·WORKLOG·STUDY). 학습 노트(`docs/learn/`)는 `expand-code.js` 로 다시 만들 수 있다.
- `.gitignore` 에 `tools/` 가 있다(cloudflared 용) → 스크립트는 `scripts/` 에.
- 화면은 `[hidden]{display:none!important}` 에 기대고 있다 — `display` 를 주는 클래스가 `hidden` 을 덮어쓰던 버그가 있었음.
- iframe(시안 페이지) 안에서 `scrollIntoView` 를 쓰면 바깥 페이지가 스크롤된다 → 목록 `scrollLeft` 로.
- **원격조종(`remote/`, `agent/`, `public/remote.js`)**: 에이전트는 Windows 내장 `csc.exe`(C# 5 — 문자열 보간·`?.` 못 씀)로 빌드. 빌드 실패가 옛 exe 를 남기지 않게 `build-agent.cmd` 가 먼저 지움 → `BUILD OK` 확인. PowerShell 시험 코드에서 `FindWindow` 의 null 인자는 `[NullString]::Value` (그냥 `$null` 은 빈 문자열이 됨). Claude Code 의 PowerShell 에는 `git`/`netstat`/`cmd` 가 PATH 에 없다. 이 환경은 SendInput 을 막을 수 있어 진짜 입력 시험은 일반 터미널에서. 원격 화면은 서버 메모리에만(키 프레임 1장+조각, 상한 6MB/2000개), PIN 은 서버가 아니라 에이전트가 확인. 단계: 1 보기·알림·PIN, 2 조종, 3 바뀐 부분만, 4 화질·코덱 — 모두 병합됨.
- **서버가 주는 에이전트 zip(`/text-tunnel-agent.zip`)**: 리눅스(Render) 서버의 `.cmd` 는 LF 라 윈도우에서 깨지므로 zip 에 넣을 때 CRLF 로 바꾼다. Host 헤더는 `.cmd` 에 들어가므로 영문·숫자·`.:-` 만 허용(명령 주입 방어). `build-agent.cmd` 는 이름만 부르지 말고 전체 경로로 호출.
- 보류된 기능: PC 실행파일(.exe, 작업 표시줄 숨기기). 후보: 종단간 암호화, 읽음 표시, 확장 스토어 등록 (`docs/STUDY.md`).
