# 학습 노트 — 작업마다 새로 쓴 기술

> 기능 하나를 만들거나 버그 하나를 고칠 때마다, 그 작업에서 **처음 쓴 기술**을 따로 공부할 수 있게 정리한다.
> 큰 그림은 [ARCHITECTURE.md](../ARCHITECTURE.md), 앞으로의 공부 순서는 [STUDY.md](../STUDY.md).

## 노트 목록

| 날짜 | 이슈 · PR | 주제 | 새로 쓴 기술 |
|---|---|---|---|
| 2026-10-20 | [#9](https://github.com/esstional-tool/text-tunnel/issues/9) · [#10](https://github.com/esstional-tool/text-tunnel/pull/10) | [놓친 메시지 다시 받기](2026-10-20-09-replay-missed-messages.md) | SSE 이벤트 ID · Last-Event-ID · 링 버퍼(TTL 로그) · 세대 번호(epoch) · 중복 제거로 만드는 "정확히 한 번처럼" · 가명 식별자(해시) |
| 2026-10-20 | [#11](https://github.com/esstional-tool/text-tunnel/issues/11) · [#12](https://github.com/esstional-tool/text-tunnel/pull/12) | [업로드 자동 재시도·이어 올리기](2026-10-20-11-upload-retry.md) | 지수 백오프 재시도 · 재시도할 오류 가르기 · 재개 가능 업로드 · 멱등한 완료 · PaaS 재시작 구간 · 변수를 하나씩 바꿔 원인 좁히기 · 네트워크 조건 흉내(CDP) |

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
