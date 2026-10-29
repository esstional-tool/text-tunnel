# 사용 기술 한눈에 보기

> text-tunnel 에 쓰인 기술을 한곳에 모은 표. 기술마다 **어디에 쓰였는지**, **관련 파일**, **자세히 공부할 곳**을 적었다.
> 큰 그림은 [ARCHITECTURE.md](ARCHITECTURE.md), 흐름은 [FLOWS.md](FLOWS.md), 작업마다 정리한 노트는 [learn/](learn/README.md), 진행 이력은 [WORKLOG.md](WORKLOG.md).

## 0. 지킨 원칙 (그래서 기술이 이렇게 단출하다)

- **DB·외부 저장소·외부 SaaS 없음** — 모든 상태는 서버 메모리에 짧게만 (파일 10분, 놓친 메시지 2분)
- **의존성 0** — 서버는 Node 기본 모듈만, 화면은 프레임워크 없이 바닐라 JS, 안드로이드 앱도 외부 라이브러리·AndroidX 없음, PC 에이전트는 Windows 내장 컴파일러로 빌드
- **기록을 남기지 않음** — 디스크·로그에 대화·열쇠·방 이름을 쓰지 않음
- 최대 2대 (내 PC ↔ 내 휴대폰)

## 1. 구성 요소 한눈에

| 구성 요소 | 위치 | 언어·플랫폼 | 역할 |
|---|---|---|---|
| 서버 | `server.js`, `remote/server.js` | Node.js 20+ (기본 모듈만) | 방·짝 맺기·메시지·파일 중계, 원격 화면·입력 중계. 상태는 메모리 |
| 웹 앱(PWA) | `public/` | 바닐라 JS · HTML · CSS | 메신저 화면, 원격 화면 보기, 휴대폰 연결 화면 |
| PC 에이전트 | `agent/Program.cs` | C# 5 (Windows 내장 `csc.exe`) | 화면을 찍어 보내고 입력을 받아 넣음 (트레이 앱) |
| 폰 앱 | `android/` | Kotlin (안드로이드 8+, 외부 라이브러리 없음) | 폰 화면을 보내고 (조종 포함 앱은) 터치·글자를 넣음 |
| 흔적 지우기 확장 | `extension/` | 크롬·엣지 확장 (Manifest V3) | 방문 기록·다운로드 기록·캐시 정리 |
| 시험 | `tests/` | Node 스크립트 (프레임워크 없음) | 서버·브라우저(CDP)·에이전트·에뮬레이터 시험 |
| 문서 도구 | `scripts/` | Node | 학습 노트의 코드 블록 갱신, 인쇄용 PDF |

## 2. 기술별 정리

### 2-1. 서버 · 통신

| 기술 | 어디에 쓰였나 | 자세히 |
|---|---|---|
| **HTTP 서버(`http` 모듈)** | 정적 파일·API 를 한 서버가 처리, 라우팅은 직접 작성 | [ARCHITECTURE §1](ARCHITECTURE.md) |
| **SSE (Server-Sent Events) + POST** | 서버→기기는 SSE, 기기→서버는 POST. 메시지·접속 상태·원격 화면 알림 | [ARCHITECTURE §2](ARCHITECTURE.md) |
| **메모리 상태·타이머** | 방·파일·놓친 메시지 보관, 만료 정리, 연결 끊김 30초 유예 | [ARCHITECTURE §3·§5](ARCHITECTURE.md) |
| **열쇠 = 권한 모델** | 32바이트 무작위 열쇠(base64url), 방 ID 는 SHA-256, 토큰은 `randomBytes` | [ARCHITECTURE §4](ARCHITECTURE.md) |
| **1회용 짝 코드** | 6자리 코드·QR, 5분·1회, 틀린 코드 반복 시 IP 10분 차단 | [FLOWS](FLOWS.md) |
| **놓친 메시지 다시 받기** | 연결이 끊긴 사이 메시지를 2분 보관했다가 이어 받기 | [learn/2026-10-20-09](learn/2026-10-20-09-replay-missed-messages.md) |
| **조각 업로드·Range·캐시** | 큰 파일을 조각으로 올리고, 동영상은 Range 로 재생, `no-store` 로 캐시 안 남김 | [ARCHITECTURE §6](ARCHITECTURE.md) · [learn/2026-10-20-11](learn/2026-10-20-11-upload-retry.md) |
| **ZIP 직접 만들기** | 서버가 시작할 때 `extension/` 을, 요청 때 에이전트 소스를 zip 으로 묶어 내려줌 (CRLF 변환, Host 헤더 허용 문자 검사) | [learn/2026-10-21-30](learn/2026-10-21-30-host-onboarding.md) |
| **정적 APK 제공** | `.apk` MIME(`application/vnd.android.package-archive`) + `Content-Disposition: attachment` 로 폰에서 바로 내려받기 | [learn/2026-10-29-48](learn/2026-10-29-48-phone-connect-button.md) |
| **Render (PaaS) 배포** | main 병합 = 자동 재배포, 무료 서버 잠들기, 12-Factor | [ARCHITECTURE §10](ARCHITECTURE.md) |

### 2-2. 웹 앱 (PWA)

| 기술 | 어디에 쓰였나 | 자세히 |
|---|---|---|
| **PWA (manifest·서비스 워커)** | 홈 화면·바탕화면 설치, 공유 대상 등록(`sw.js` 가 공유된 글·파일을 받음) | [ARCHITECTURE §7](ARCHITECTURE.md) |
| **프레임워크 없는 클라이언트** | 상태 변수 + 화면 전환(`SCREENS`) + 직접 DOM 갱신 | [ARCHITECTURE §8](ARCHITECTURE.md) |
| **QR 코드 생성** | `public/vendor/qrcode.js` (짝 맺기 화면) | — |
| **Web Share API (파일)** | 받은 PDF·사진·동영상을 기기 공유창으로 | [learn/2026-10-23-35](learn/2026-10-23-35-share-files.md) |
| **File 참조 다루기** | 고른 사진을 바로 복사·재시도해 읽기(클라우드 사진·저장 중 사진) | [learn/2026-10-26-40](learn/2026-10-26-40-hold-picked-files.md) |
| **토스·카카오톡 스타일 UI** | 바텀시트, 말풍선, 다크 모드 자동(`prefers-color-scheme`) | README "디자인" |
| **화면 전환 + 하위 시트** | 메뉴 → "PC 원격 연결"(허용 켜기·화면 보기) / "휴대폰 원격 연결하기" | [learn/2026-10-29-50](learn/2026-10-29-50-phone-view-only.md) |

### 2-3. 원격 화면 보기·조종 (PC)

| 기술 | 어디에 쓰였나 | 자세히 |
|---|---|---|
| **에이전트–서버–보는 쪽 3자 프로토콜** | 에이전트 입장 → SSE(`viewers`·`auth`·`input`) → 화면 POST. 서버는 중계만 | [learn/2026-10-20-17](learn/2026-10-20-17-remote-view.md) |
| **화면 캡처 (GDI `CopyFromScreen`)·JPEG 인코딩** | 에이전트(C#)가 화면을 찍어 JPEG 로 압축 | [learn/2026-10-20-17](learn/2026-10-20-17-remote-view.md) |
| **바뀐 부분만 전송 (dirty-rect)** | 64×64 칸으로 나눠 이전 화면과 비교, 바뀐 칸만 조각으로 | [learn/2026-10-20-24](learn/2026-10-20-24-dirty-rect.md) |
| **화질·속도 자동 조절·코덱 선택** | 업로드 시간 이동평균 + 서버 slow 신호로 품질(25~92)·간격 조절 | [learn/2026-10-20-25](learn/2026-10-20-25-quality-codec.md) |
| **접속 PIN (PBKDF2)** | PIN 은 조종당하는 쪽이 해시(PBKDF2 + 솔트)로만 저장하고 직접 확인, 서버는 모름. 5회 틀리면 10분 잠금 | [learn/2026-10-20-21](learn/2026-10-20-21-remote-pin.md) |
| **Win32 입력 주입 (`SendInput`)** | 마우스·키보드 조종, 좌표는 화면 비율(0~1) | [learn/2026-10-20-23](learn/2026-10-20-23-remote-control.md) |
| **접속 알림 장치** | 맨 위 빨간 띠(1초마다 최상단 복구), 토스트·소리, 접속 기록(`access.log`) | [learn/2026-10-20-19](learn/2026-10-20-19-agent-alerts.md) |
| **전역 단축키·트레이 앱·자동 실행** | `RegisterHotKey`(Ctrl+Alt+F12 즉시 중지), `NotifyIcon`, 시작 프로그램(HKCU Run) | [learn/2026-10-21-30](learn/2026-10-21-30-host-onboarding.md) |
| **앱에서 원격 허용 켜기 안내** | 에이전트 실시간 상태 표시, zip 받기, 빌드 안내 | [learn/2026-10-21-30](learn/2026-10-21-30-host-onboarding.md) |

### 2-4. 폰 원격 (안드로이드)

| 기술 | 어디에 쓰였나 | 자세히 |
|---|---|---|
| **같은 프로토콜 재사용** | 폰 앱도 PC 에이전트처럼 입장(`platform: android`)하므로 서버·보는 화면 대부분 그대로 | [learn/2026-10-29-46](learn/2026-10-29-46-phone-remote.md) |
| **MediaProjection + ImageReader** | 폰 화면 캡처 → JPEG(`Bitmap.compress`) → 서버로 전송 | [learn/2026-10-29-46](learn/2026-10-29-46-phone-remote.md) |
| **포그라운드 서비스(mediaProjection 유형)** | 안드로이드 14+ 규칙(`startForeground` 먼저, 콜백 먼저 등록, VirtualDisplay 재사용), 항상 떠 있는 알림 + "중지" | [learn/2026-10-29-46](learn/2026-10-29-46-phone-remote.md) |
| **접근성 서비스 `dispatchGesture`** | 마우스 → 터치 번역(탭·길게·스와이프·스크롤), 뒤로·홈·최근·알림 전역 동작 | [learn/2026-10-29-46](learn/2026-10-29-46-phone-remote.md) |
| **`ACTION_SET_TEXT`·`SET_SELECTION`** | PC 키보드·"글자 보내기"(한글 포함)를 입력칸 커서 위치에 넣기 | [learn/2026-10-29-46](learn/2026-10-29-46-phone-remote.md) |
| **PBKDF2 PIN (`SecretKeyFactory`)** | PC 와 같은 방식으로 폰이 직접 PIN 확인 | [learn/2026-10-20-21](learn/2026-10-20-21-remote-pin.md) |
| **외부 라이브러리 없는 네트워킹** | `HttpURLConnection` 으로 SSE 읽기·POST | `android/.../Http.kt` |
| **딥링크 `texttunnel://connect`** | 코드·서버 주소가 실린 링크로 앱을 열어 자동 짝 맺기 (모르는 서버는 확인 창) | [learn/2026-10-29-48](learn/2026-10-29-48-phone-connect-button.md) |
| **인텐트 링크 + 폴백 URL** | 크롬이 앱 설치 여부를 판단: 있으면 열기, 없으면 APK 내려받기 | [learn/2026-10-29-48](learn/2026-10-29-48-phone-connect-button.md) |
| **APK 서명 (릴리스 keystore)** | 키는 저장소 밖, 같은 키로 서명해야 업데이트됨. `apksigner` 로 검증 | [learn/2026-10-29-48](learn/2026-10-29-48-phone-connect-button.md) |
| **Gradle product flavor** | `view`(보기 전용, 접근성 선언 없음) / `control`(조종 포함) 두 앱. flavor 별 소스·매니페스트 | [learn/2026-10-29-50](learn/2026-10-29-50-phone-view-only.md) |
| **Play 프로텍트 대응** | 접근성 권한 앱은 설치가 막힘 → 보기 전용을 기본으로, 안내 화면 | [learn/2026-10-29-50](learn/2026-10-29-50-phone-view-only.md) |

### 2-5. 브라우저 확장

| 기술 | 어디에 쓰였나 | 자세히 |
|---|---|---|
| **Manifest V3 확장** | 백그라운드 서비스 워커·콘텐츠 스크립트·팝업 | [ARCHITECTURE §9](ARCHITECTURE.md) |
| **`history`·`browsingData`·`downloads` API** | 방문·검색·다운로드 기록, 캐시 삭제. 대상은 8787 포트 앱만 | [ARCHITECTURE §9](ARCHITECTURE.md) |
| **단축키 명령 (`commands`)** | 완전 정리(기본 Ctrl+Shift+9, 충돌하면 8 등으로 변경) | [ARCHITECTURE §9](ARCHITECTURE.md) |

### 2-6. 시험·문서 도구

| 기술 | 어디에 쓰였나 | 자세히 |
|---|---|---|
| **Node 시험 스크립트** | 서버 시험(`pair`·`rejoin`·`replay`·`upload`·`remote*`·`share`·`pick` …), 프레임워크 없이 PASS/FAIL 출력 | [ARCHITECTURE §11](ARCHITECTURE.md) |
| **헤드리스 Edge + CDP** | 실제 브라우저로 화면 시험(탭 열기·함수 호출·네트워크 지연·확장 로드) | README "시험" |
| **진짜 에이전트 exe 시험** | `--fake-screen`(합성 화면)·`--input-sink`(입력을 파일에 기록)로 화면·입력 검증 | README "시험" |
| **안드로이드 에뮬레이터 시험** | adb·uiautomator 로 딥링크→PIN→화면 공유→조종→알림 "중지"까지 끝까지 확인 | `tests/phone-agent.test.js` |
| **APK 검사** | 서명 블록·`apksigner`·`aapt2` 로 매니페스트(접근성 선언 유무) 확인 | `tests/phone-connect.test.js` |
| **학습 노트·PDF** | 노트의 📄 코드 블록 갱신(`expand-code.js`), 인쇄용 PDF(`docs-pdf.js`) | [learn/README](learn/README.md) |
| **GitHub 흐름** | 이슈 → 브랜치 → PR(`Closes #N`) → "확정" 후 병합 → 배포 확인 | [WORKLOG](WORKLOG.md) |

## 3. 기능별로 쓰인 기술 (지도)

| 기능 | 핵심 기술 |
|---|---|
| 메신저(글·사진·동영상·파일) | SSE+POST, 메모리 보관·만료, 조각 업로드, Range, `no-store` |
| 짝 맺기 | 1회용 코드·QR, 32바이트 열쇠, SHA-256 방 ID, IP 차단 |
| 놓친 메시지 | 2분 메모리 보관, 이어 받기 |
| 흔적 지우기 | MV3 확장(history·browsingData·downloads), 단축키 |
| PC 원격 보기·조종 | C# 에이전트(GDI·JPEG·SendInput·트레이), dirty-rect, 화질 자동 조절, PBKDF2 PIN |
| 폰 원격 보기·조종 | MediaProjection, 포그라운드 서비스, 접근성 `dispatchGesture`, `SET_TEXT` |
| 휴대폰 원격 연결하기 | 인텐트 링크·폴백, 딥링크, APK 서명·제공 |
| 보기 전용 / 조종 포함 | Gradle product flavor, Play 프로텍트 대응 |
| 파일 공유 | Web Share API, 서비스 워커 공유 대상 |
| 배포 | Render, 자동 재배포, 12-Factor |

## 4. 보류·후보

종단간 암호화, 읽음 표시, 확장 스토어 등록, PC 실행파일(.exe, 작업 표시줄 숨기기), 폰에서 PC 화면 보기(PR #45, 병합 전) — 자세한 것은 [STUDY.md](STUDY.md).

## 5. 이 문서 관리법

- 기능을 추가하면 이 표의 **해당 줄**(또는 새 줄)을 같이 고친다. 학습 노트를 새로 쓰면 링크도 건다.
- 설명이 길어질 것 같으면 표에는 한 줄만, 자세한 건 학습 노트·ARCHITECTURE 에 쓴다.
