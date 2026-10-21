# 업로드 자동 재시도·이어 올리기

> 이슈 [#11](https://github.com/esstional-tool/text-tunnel/issues/11) · PR [#12](https://github.com/esstional-tool/text-tunnel/pull/12) · 2026-10-20
> 휴대폰 사진 전송이 "연결이 끊겼어요"로 실패하던 문제. 원인은 서버 재시작 구간, 해결은 **재시도 + 받은 위치에서 이어 올리기 + 중복 방지**.

## 어떤 문제였나

휴대폰에서 사진을 보내면 가끔 `1개를 못 보냈어요 · 연결이 끊겼어요`. 코드에 버그가 있었던 게 아니라, **서버가 잠깐 사라지는 순간을 견디지 못했다.**

## 원인을 좁힌 과정 (이 작업에서 가장 배울 것)

추측으로 고치지 않고, **변수를 하나씩 바꿔 가며** 범위를 좁혔다.

| 시도 | 결과 | 알게 된 것 |
|---|---|---|
| PC 브라우저(앱 코드 그대로) → Render | 간헐적 실패: `401` 다음 `502 Bad Gateway (cloudflare)` | 휴대폰 문제가 아님. 재현 가능 |
| 같은 크기를 Node 로 → Render | 성공 | 크기·서버 처리 로직 문제 아님 |
| 브라우저 → 로컬 서버, 15MB 까지 | 성공, 서버 오류 없음 | 코드 자체는 정상 |
| "끝난 응답에 쓰다 서버가 죽는다" 가설을 로컬에서 재현 | 서버 안 죽음 | **가설 기각** — 틀린 가설은 빨리 버린다 |
| 브라우저 업로드를 요청·재입장·SSE 오류까지 기록하며 다시 → Render | 이번엔 성공 | **간헐적** — 특정 시점에만 실패 |
| 401(서버가 이 기기를 모름) + 502(앞단이 서버에 연결 실패) 조합 + 직전 배포 | — | **서버 재시작 구간**: 옛/새 인스턴스가 바뀌는 몇 초 |

그리고 진짜 결함은 **"앱이 한 번 실패하면 재시도 없이 포기한다"** 였다. 서버는 언제든 재시작될 수 있으니(배포, 무료 플랜 잠들기/깨어나기), 앱이 그걸 견뎌야 한다.

## 새로 쓴 기술

### 1. 지수 백오프 재시도 (exponential backoff)

- **개념**: 실패하면 기다렸다 다시 시도하되, **기다리는 시간을 매번 두 배로** 늘린다(1·2·4·8·16초). 서버가 막 살아나는 중에 요청을 퍼부어 더 힘들게 만들지 않으려는 것.
- **이 코드에서는**: 최대 5번. 성공하면 시도 횟수를 0으로 되돌린다(조각마다 따로 셈). 진행 표시에 "연결이 끊겨 다시 시도하는 중… (n/5)".
- **주의할 점**: 많은 기기가 동시에 같은 간격으로 재시도하면 한꺼번에 몰린다(thundering herd). 실서비스는 대기 시간에 무작위 흔들림(**jitter**)을 섞는다. 이 앱은 기기가 둘뿐이라 생략 — 다음에 해 볼 만한 개선.

### 2. 다시 해도 되는 실패와 아닌 실패 가르기

- **개념**: 모든 실패를 재시도하면 안 된다. **일시적인 실패**만 다시 한다.
- **이 코드에서는**:

| 응답 | 뜻 | 처리 |
|---|---|---|
| `0` (연결 끊김·시간 초과) | 네트워크/서버 사라짐 | 재시도 |
| `401` | 입장권이 무효 (서버 재시작·다른 곳에서 재입장) | 재입장 후 재시도 |
| `409` | 조각 위치가 어긋남 | 위치를 물어 재시도 |
| `5xx` (502 등) | 서버·앞단 일시 장애 | 재시도 |
| `400` `413` `507` | 잘못된 요청·크기 초과·서버 메모리 가득 | **바로 실패 표시** (다시 해도 같음) |

- **주의할 점**: HTTP 의 기본 감각은 "4xx = 내 잘못(재시도 무의미), 5xx = 서버 잘못(재시도 의미 있음)" 이지만, 401·409 처럼 **상황을 고친 뒤** 재시도할 수 있는 4xx 도 있다. 앱의 상태와 함께 판단해야 한다.

### 3. 재개 가능 업로드 (resumable upload)

- **개념**: 큰 파일을 조각으로 나눠 올리고, 끊기면 **서버에 "어디까지 받았어?"를 물어 그 다음부터** 이어 올린다. tus 프로토콜, S3 멀티파트 업로드가 같은 구조다.
- **이 코드에서는**: `GET /api/upload?uid=` 가 `{ received, total }` 을 돌려준다. 서버가 그 업로드를 모르면(재시작으로 메모리가 날아감) `404` → 새 uid 로 처음부터.
- **주의할 점**: 조각을 **순서대로** 받기 때문에 "받은 양" 하나로 위치를 표현할 수 있다. 조각을 병렬로 받으려면 "어느 조각을 받았나" 목록이 필요해진다(S3 멀티파트의 part number).

<!-- code: server.js FROM "if (p === '/api/upload' && req.method === 'GET')" | 받은 위치 / 완료 / 모름 -->
<details>
<summary>📄 실제 코드 — <code>server.js</code> 350–355 · 받은 위치 / 완료 / 모름</summary>

[GitHub에서 보기](../../server.js#L350-L355)

```js
  if (p === '/api/upload' && req.method === 'GET') {
    const uid = url.searchParams.get('uid') || '';
    if (room.done.has(uid)) return send(res, 200, { done: true });
    const up = room.uploads.get(uid);
    return up ? send(res, 200, { received: up.received, total: up.total }) : send(res, 404, { received: 0 });
  }
```

</details>
<!-- /code -->

### 4. 멱등한 완료 — 같은 사진이 두 번 가지 않게

- **개념**: 마지막 조각을 서버가 다 받고 사진을 상대에게 보냈는데, **응답만** 끊겨 앱은 실패로 안다. 그대로 처음부터 다시 올리면 같은 사진이 두 번 간다. 그래서 서버가 **완료한 업로드 ID 를 잠깐(10분) 기억**하고, 물어보면 `done` 이라고 답한다. 같은 요청을 몇 번 반복해도 결과가 한 번 한 것과 같으면 *멱등(idempotent)* 하다고 한다.
- **이 코드에서는**: `room.done` Map 에 uid 를 넣고 10분 뒤 지운다. 앱은 `done` 을 받으면 성공으로 끝낸다.
- **주의할 점**: 결제 API 의 *Idempotency-Key* 헤더가 같은 생각이다(같은 키로 두 번 결제 요청해도 한 번만 결제).

<!-- code: server.js FROM "room.done.set(uid" TO "setTimeout\(\(\) => room.done" | 완료 기억 -->

### 5. 재시도 루프 전체 — 입장권 확인 포함

<!-- code: public/app.js FROM "async function ensureJoined" | 입장권 확인·필요하면 재입장 -->
<details>
<summary>📄 실제 코드 — <code>public/app.js</code> 394–398 · 입장권 확인·필요하면 재입장</summary>

[GitHub에서 보기](../../public/app.js#L394-L398)

```js
async function ensureJoined() {
  if (token && (await fetch(api('ping')).catch(() => null))?.ok) return;
  es?.close(); token = null; joinRoom();
  for (let i = 0; i < 40 && !token; i++) await sleep(500);
}
```

</details>
<!-- /code -->
<!-- code: public/app.js FROM "function postChunk" | 조각 하나 올리기 (실패해도 예외 대신 상태 반환, 2분 시간 제한) -->
<details>
<summary>📄 실제 코드 — <code>public/app.js</code> 401–413 · 조각 하나 올리기 (실패해도 예외 대신 상태 반환, 2분 시간 제한)</summary>

[GitHub에서 보기](../../public/app.js#L401-L413)

```js
function postChunk(uid, file, offset, batch, onProgress) {
  const part = file.slice(offset, offset + UPLOAD_CHUNK);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api('upload', { uid, offset, total: file.size, name: file.name, ...(batch ? { batch } : {}) }));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.timeout = 120000; // 휴대폰 네트워크가 멈춰 버린 경우
    xhr.upload.onprogress = (e) => onProgress(offset + e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, size: part.size });
    xhr.onerror = xhr.ontimeout = () => resolve({ status: 0, text: '' });
    xhr.send(part);
  });
}
```

</details>
<!-- /code -->
<!-- code: public/app.js FROM "async function uploadOne" | 재시도·이어 올리기 루프 -->
<details>
<summary>📄 실제 코드 — <code>public/app.js</code> 420–443 · 재시도·이어 올리기 루프</summary>

[GitHub에서 보기](../../public/app.js#L420-L443)

```js
async function uploadOne(file, batch, onProgress, onRetry) {
  let uid = randId();
  let offset = 0;
  let tries = 0;
  for (;;) {
    const r = await postChunk(uid, file, offset, batch, onProgress);
    if (r.status === 200) {
      tries = 0;
      if (r.text === 'done') return;
      offset += r.size;
      continue;
    }
    // 다시 해도 똑같은 결과일 실패는 바로 알린다 (크기 초과, 서버 메모리 가득, 잘못된 요청)
    if ([400, 413, 507].includes(r.status)) throw new Error(r.text || '실패');
    if (++tries > RETRY_MAX) throw new Error(r.status ? (r.text || `오류 ${r.status}`).slice(0, 80) : '연결이 끊겼어요');
    onRetry?.(tries);
    await sleep(1000 * 2 ** (tries - 1)); // 1·2·4·8·16초
    await ensureJoined();
    const s = await fetch(api('upload', { uid })).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (s?.done) return;                              // 다 올라갔는데 응답만 끊긴 경우
    if (s) offset = s.received;                       // 받은 데까지 건너뛰고 이어서
    else { uid = randId(); offset = 0; }              // 서버가 모름(재시작) → 처음부터
  }
}
```

</details>
<!-- /code -->

- `postChunk` 가 실패를 **예외 대신 값(`{ status }`)으로** 돌려주는 이유: 루프에서 상태별로 갈라 처리하기 쉽다. `try/catch` 로 하면 "어떤 실패였나"를 잃기 쉽다.
- `xhr.timeout = 120000`: 휴대폰 네트워크가 **에러도 안 내고 멈춰 버리는** 경우가 있다. 시간 제한이 없으면 영원히 기다린다.
- 업로드에 `fetch` 가 아니라 `XMLHttpRequest` 를 쓰는 이유: `fetch` 는 **업로드 진행률** 이벤트가 없다.

### 6. PaaS 재시작 구간 (Render)

- **개념**: 무료 PaaS 는 배포하거나 잠들었다 깨어날 때 **새 인스턴스를 띄우고 옛 인스턴스를 내린다.** 그 몇 초 동안 요청이 옛/새로 갈리거나 끊긴다. 메모리 상태(입장권, 업로드 조각)는 새 인스턴스에 없다.
- **502 Bad Gateway**: 앞단 프록시(여기선 Cloudflare)가 뒤의 서버에서 정상 응답을 못 받았다는 뜻. 서버가 죽었거나 재시작 중일 때 흔하다.
- **교훈**: 상태를 메모리에 두는 서버(→ [ARCHITECTURE §1](../ARCHITECTURE.md))는 **"서버는 언제든 사라질 수 있다"** 를 클라이언트가 견뎌야 한다. 클라우드 설계 원칙 *design for failure*.

### 7. 네트워크 조건 흉내 내서 사고 재현하기 (CDP)

- **개념**: 문제를 고쳤다는 걸 보이려면 **사고를 일부러 일으켜** 봐야 한다. Chrome DevTools Protocol 의 `Network.emulateNetworkConditions` 로 업로드 속도를 초당 600KB 로 떨어뜨려, 업로드가 진행되는 동안 사고를 낼 시간을 벌었다.
- **시험한 사고**: ① 업로드 도중 **서버를 죽였다 2.5초 뒤 재시작** → "다시 시도 (1/5)" 후 완료 ② 15MB(두 조각) 업로드 도중 **입장권 무효** → 재입장 후 이어서 완료.
- **주의할 점**: 처음엔 사진이 조각 하나라 입장권을 무효로 해도 이미 받아들여진 요청이 끝나 버려 **시험이 아무것도 시험하지 않았다.** 결과가 "통과"여도 **의도한 경로를 실제로 탔는지** 확인해야 한다.

## 어떻게 시험했나

- `tests/upload.test.js` (9항목): 모르는 업로드 404 · 받은 위치 · 어긋난 위치 409 후 이어서 · 완료 후 done · 재입장 후 같은 업로드 위치 확인
- 실제 Edge + 업로드 속도 제한 + 서버를 시험 스크립트가 직접 죽이고 띄움 (위 7번)
- Render 배포 후 처음 실패를 재현한 브라우저 업로드 3건(5.6MB, 15.5MB×2) 모두 성공

## 더 공부할 키워드·자료

- Exponential backoff and jitter — AWS Architecture Blog 글이 고전
- tus.io — Resumable upload protocol (HEAD 로 offset 묻기)
- AWS S3 Multipart Upload, Google Cloud Storage resumable uploads
- Idempotency key (Stripe API 문서)
- HTTP 상태 코드: 401 vs 403, 409, 502 vs 503 vs 504 — MDN
- Release It! (Michael Nygard) — 타임아웃·서킷 브레이커·재시도 같은 안정성 패턴
- Chrome DevTools Protocol — Network domain

## 스스로 확인

<details><summary>1. 왜 기다리는 시간을 매번 두 배로 늘리나? 고정 1초면 안 되나?</summary>

서버가 막 살아나는 중이거나 과부하일 때 일정한 간격으로 계속 두드리면 회복을 방해한다. 간격을 늘리면 짧은 장애는 빨리 넘기고, 긴 장애에서는 요청을 줄인다.
</details>

<details><summary>2. 413(너무 큼)을 재시도하면 어떻게 되나?</summary>

같은 크기를 다시 보내니 다섯 번 모두 413이 나고 시간만 30초 넘게 버린다. 그래서 바로 실패로 표시한다.
</details>

<details><summary>3. 서버가 완료한 업로드를 기억하지 않으면 어떤 버그가 생기나?</summary>

마지막 응답만 끊긴 경우 앱이 실패로 알고 처음부터 다시 올려서, 받는 쪽에 같은 사진이 두 번 온다.
</details>

<details><summary>4. 처음 재현 시험에서 401 다음에 502 가 온 것은 무슨 순서의 사건이었나?</summary>

새 인스턴스로 바뀐 직후 요청이 새 인스턴스로 가서 "모르는 입장권"(401), 이어서 옛 인스턴스가 내려가는 중이던 요청을 앞단이 전달하지 못함(502). 둘 다 서버 재시작 구간의 증상이다.
</details>

<details><summary>5. "끝난 응답에 쓰다가 서버가 죽는다" 가설은 왜 버렸나? 그 판단에서 배울 점은?</summary>

같은 조건(연결을 재사용하는 클라이언트 + 같은 기기 재입장 + 25초 대기)을 로컬에서 만들었는데 서버가 살아 있었다. 그럴듯한 가설도 **재현으로 확인**하고, 안 되면 빨리 버리고 다음 증거로 넘어가야 한다.
</details>
