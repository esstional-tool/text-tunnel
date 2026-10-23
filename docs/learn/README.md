# 학습 노트 — 작업마다 새로 쓴 기술

> 기능 하나를 만들거나 버그 하나를 고칠 때마다, 그 작업에서 **처음 쓴 기술**을 따로 공부할 수 있게 정리한다.
> 큰 그림은 [ARCHITECTURE.md](../ARCHITECTURE.md), 앞으로의 공부 순서는 [STUDY.md](../STUDY.md).

## 노트 목록

| 날짜 | 이슈 · PR | 주제 | 새로 쓴 기술 |
|---|---|---|---|
| 2026-10-20 | [#9](https://github.com/esstional-tool/text-tunnel/issues/9) · [#10](https://github.com/esstional-tool/text-tunnel/pull/10) | [놓친 메시지 다시 받기](2026-10-20-09-replay-missed-messages.md) | SSE 이벤트 ID · Last-Event-ID · 링 버퍼(TTL 로그) · 세대 번호(epoch) · 중복 제거로 만드는 "정확히 한 번처럼" · 가명 식별자(해시) |
| 2026-10-20 | [#11](https://github.com/esstional-tool/text-tunnel/issues/11) · [#12](https://github.com/esstional-tool/text-tunnel/pull/12) | [업로드 자동 재시도·이어 올리기](2026-10-20-11-upload-retry.md) | 지수 백오프 재시도 · 재시도할 오류 가르기 · 재개 가능 업로드 · 멱등한 완료 · PaaS 재시작 구간 · 변수를 하나씩 바꿔 원인 좁히기 · 네트워크 조건 흉내(CDP) |
| 2026-10-20 | [#17](https://github.com/esstional-tool/text-tunnel/issues/17) · [#18](https://github.com/esstional-tool/text-tunnel/pull/18) | [원격 화면 보기 (1단계)](2026-10-20-17-remote-view.md) | 화면 캡처(GDI) · JPEG 인코딩 · pull 방식 알림 · 수요 기반 캡처 · 열쇠=자격(네임스페이스 해시) · C# 5 내장 csc · 트레이/최상위 띠 |
| 2026-10-20 | [#19](https://github.com/esstional-tool/text-tunnel/issues/19) · [#20](https://github.com/esstional-tool/text-tunnel/pull/20) | [원격 접속 알림](2026-10-20-19-agent-alerts.md) | Z-order/TOPMOST 재올리기 · 상태 변화 순간만 알리기 · 토스트/소리 · 알림 위치 설계(조종당하는 쪽만) |
| 2026-10-20 | [#21](https://github.com/esstional-tool/text-tunnel/issues/21) · [#22](https://github.com/esstional-tool/text-tunnel/pull/22) | [접속 PIN](2026-10-20-21-remote-pin.md) | PBKDF2 해시 · 끝단(에이전트)에서 검증 · 이중 잠금(에이전트+서버) · 기본 거부 · 자동 재인증 |
| 2026-10-20 | [#23](https://github.com/esstional-tool/text-tunnel/issues/23) · [#26](https://github.com/esstional-tool/text-tunnel/pull/26) | [원격 조종(마우스·키보드)](2026-10-20-23-remote-control.md) | mouse_event/keybd_event · 눌린 키 자동 떼기 · RegisterHotKey 즉시 중지 · 입력 묶음(coalescing) · test sink |
| 2026-10-20 | [#24](https://github.com/esstional-tool/text-tunnel/issues/24) · [#27](https://github.com/esstional-tool/text-tunnel/pull/27) | [바뀐 부분만 보내기](2026-10-20-24-dirty-rect.md) | 칸 비교(memcmp) · 사각형 합치기 · 키 프레임+조각 · since 커서 · 합성 화면 시험 |
| 2026-10-20 | [#25](https://github.com/esstional-tool/text-tunnel/issues/25) · [#28](https://github.com/esstional-tool/text-tunnel/pull/28) | [화질 자동 조절·코덱 선택](2026-10-20-25-quality-codec.md) | EMA 피드백 제어(AIMD 비슷) · 종단 backpressure(slow) · JPEG/PNG 선택 · 프로필 · 지연 프록시 시험 |
| 2026-10-21 | [#30](https://github.com/esstional-tool/text-tunnel/issues/30) · [#31](https://github.com/esstional-tool/text-tunnel/pull/31) | [앱에서 원격 허용 켜기](2026-10-21-30-host-onboarding.md) | 동적 zip(서버 주소 주입)·Host 헤더 주입 방어 · .cmd CRLF·%~dp0 · 시작 프로그램(HKCU Run) · 실시간 상태(SSE agent 알림) |
| 2026-10-23 | [#35](https://github.com/esstional-tool/text-tunnel/issues/35) | [받은 파일 공유하기](2026-10-23-35-share-files.md) | navigator.share/canShare(파일) · 사용자 동작 허용 만료와 두 번 누르기 · 메모리에만 두고 지우면 비우기 · 브라우저 API 를 가짜로 심어 시험 |

## 노트 쓰는 법 (다음 작업부터 같은 형식)

파일 이름: `YYYY-MM-DD-<이슈번호 두 자리>-<영문-주제>.md`

```md
# <주제>
> 이슈 #N · PR #M · 한 줄 요약

## 어떤 문제였나
## 새로 쓴 기술
### 1. <기술 이름>
- **개념**:
- **왜 필요했나**:
- **이 코드에서는**:
- **주의할 점**:
<!-- code: <파일> FROM "<시작 문구>" | <제목> -->
## 어떻게 시험했나
## 더 공부할 키워드·자료
## 스스로 확인 (답은 접어 두기)
```

코드 표시(`<!-- code: … -->`)를 넣고 아래를 실행하면 📄 실제 코드 펼치기가 생긴다. 코드가 바뀐 뒤 다시 실행하면 갱신된다.

```
node scripts/expand-code.js docs/learn/*.md
```
