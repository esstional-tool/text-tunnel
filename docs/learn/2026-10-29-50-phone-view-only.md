# 폰 앱 보기 전용 버전 (이슈 #50)

갤럭시에서 폰 앱을 설치하려 하자 Google Play 프로텍트가 "기기 보호를 위해 앱 차단됨"으로 막았다. 접근성 서비스(조종) 권한 때문이라, 그 권한이 없는 보기 전용 앱을 따로 만든 작업의 학습 노트.

## 1. Play 프로텍트 차단
- **개념**: Play 스토어 밖에서 받은 앱이 접근성 같은 민감한 권한을 요청하면 설치를 막는다. 사용자가 "확인"을 눌러도 그냥 닫힌다. 웹페이지·앱이 대신 끌 수 없다.
- **왜 이렇게 풀었나**: 앱이 설치조차 안 되면 기능이 소용없다. 화면 보기(MediaProjection)는 차단 대상이 아니라서, 접근성이 없는 버전을 기본으로 한다.
- **주의**: 실제로 안 막히는지는 갤럭시에서 직접 확인해야 한다(에뮬레이터에는 이 차단이 없다).

## 2. 안드로이드 product flavor
- `android/app/build.gradle.kts` 에 `flavorDimensions` + `productFlavors`: `control`(기존 앱 ID — 이미 깐 앱이 업데이트됨), `view`(다른 앱 ID — 한 폰에 둘 다 설치 가능).
- flavor 별 소스: 접근성 서비스 클래스·설정 XML·매니페스트의 `<service>` 는 `src/control` 에만. `src/view` 에는 같은 이름·같은 모양의 **빈 클래스**(항상 꺼짐)를 두어 나머지 코드를 안 고쳐도 되게 했다.
- `BuildConfig.CONTROL` 로 설정 화면의 조종 항목을 숨김.

## 3. 시험
- aapt2 로 APK 의 매니페스트를 읽어 "보기 전용에는 BIND_ACCESSIBILITY_SERVICE 가 없고 조종 포함에는 있다"를 확인 (`phone-connect.test.js`).
- 에뮬레이터 시험은 `assembleControlDebug` 로 만든 앱으로.

## 스스로 확인
<details><summary>왜 `control` 은 앱 ID 를 그대로 두고 `view` 만 바꿨나?</summary>이미 설치된 앱이 업데이트되어야 하고(같은 ID + 같은 서명), 두 앱을 한 폰에 같이 둘 수 있어야 해서.</details>
