# 휴대폰 원격 연결하기 버튼 (이슈 #48)

폰에서 버튼 하나로 "앱이 있으면 열기, 없으면 내려받기"를 하고 짝 맺기까지 자동으로 하는 흐름을 만든 작업의 학습 노트.

## 1. 안드로이드 인텐트 링크
- **개념**: 크롬은 `intent://호스트?쿼리#Intent;scheme=…;package=…;S.browser_fallback_url=…;end` 링크를 보면 해당 패키지 앱이 있으면 열고, 없으면 `browser_fallback_url` 로 이동한다.
- **왜**: 웹은 앱 설치 여부를 알 수 없다. 이 링크는 브라우저가 대신 판단해 준다.
- **이 코드에서**: `public/remote.js` 의 `makePhoneLink()`. 폴백 주소가 APK 다운로드 주소.
- **주의**: 폴백 주소는 `encodeURIComponent` 로 감싼다. iOS·PC 에서는 의미가 없어 안내 문구만 보인다.

## 2. 딥링크와 자동 짝 맺기
- 앱의 `AndroidManifest.xml` 에 `texttunnel://connect` VIEW/BROWSABLE intent-filter. 링크의 `code`(5분·1회용)와 `server` 로 `pair/claim` 을 자동 호출. 모르는 서버 주소는 확인 창을 먼저 띄운다.

## 3. APK 내려받기와 서명
- 서버: `.apk` MIME `application/vnd.android.package-archive` + `Content-Disposition: attachment`.
- 업데이트가 되려면 **항상 같은 키로 서명**해야 한다 → 저장소 밖 keystore, 백업 필수. `*.apk` 는 gitignore 라 `git add -f`.

## 4. 시험하며 겪은 것
- 알림창 "중지" 단추: 알림이 묶여 접혀 있어 uiautomator 로 안 보임 → 묶음과 상시 알림을 차례로 펼친다. 앱이 앞에 있으면 uiautomator 가 알림창 대신 앱을 읽으므로 홈 위에서 연다.
- 오른쪽 버튼=뒤로: 대화상자가 떠 있으면 뒤로 가기는 그것만 닫으므로, 화면 이동 대신 앱이 동작을 실행했는지(로그)로 확인.
- `//` 주석이 같은 줄의 템플릿 문자열 끝까지 먹어 구문 오류가 났다.

## 시험 방법
서버 + Edge(9333) 를 띄우고 `node tests/phone-connect.test.js http://localhost:8787` (20), 에뮬레이터로 `phone-agent.test.js`.

## 스스로 확인
<details><summary>앱이 설치됐는지 웹은 어떻게 알 수 있나?</summary>알 수 없다. 인텐트 링크로 브라우저에 맡긴다.</details>
