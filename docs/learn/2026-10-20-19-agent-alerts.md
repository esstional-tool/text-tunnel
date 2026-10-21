# 원격 접속 알림: 띠 유지 · 토스트 · 소리 (조종당하는 PC 쪽만)

> 이슈 [#19](https://github.com/esstional-tool/text-tunnel/issues/19) · 2026-10-20
> 원격조종 1단계([노트](2026-10-20-17-remote-view.md))의 후속 안전장치. 빨간 띠가 다른 창에 가려져도 복구하고, 누군가 보기 시작하는 순간을 이 PC 앞의 사람에게 알린다.

## 어떤 문제였나

띠는 "항상 맨 위에 떠 있는" 창이지만, **다른 최상위 창이 덮을 수 있다**(발표 화면, 전체 화면 동영상 등). 덮이면 누가 보고 있는지 모르게 되어 띠의 의미가 사라진다. 또 접속하는 **순간**을 알려 주는 것이 없었다.

설계 결정: 이 알림은 **조종당하는 PC(에이전트)에서만** 나온다. 보는 PC에는 알림·소리·띠를 넣지 않고, 서버가 보는 쪽에 새 종류의 신호를 보내지도 않는다.

## 새로 쓴 기술

### 1. 창의 겹치는 순서(Z-order)와 `TOPMOST`

- **개념**: Windows의 창은 화면에서 쌓이는 순서(Z-order)가 있다. 맨 위 층인 **TOPMOST** 창끼리는 나중에 맨 위로 올린 것이 위에 온다. 그래서 `TopMost = true`인 창도 **다른 TOPMOST 창이 뒤에 올라오면 덮인다.**
- **이 코드에서는**: 보는 동안 1초마다 `SetWindowPos(HWND_TOPMOST, …)`를 다시 불러 맨 위로 올린다. 플래그로 위치·크기는 그대로(`NOMOVE|NOSIZE`), **포커스는 빼앗지 않게**(`NOACTIVATE`) 한다 — 쓰던 창에서 타이핑하던 사람이 갑자기 포커스를 잃으면 안 된다.
- **주의할 점**: 독점 전체 화면(exclusive fullscreen) 게임은 최상위 창으로도 못 덮을 수 있다. 그래서 띠 하나에 의존하지 않고 토스트와 소리를 함께 쓴다(여러 겹의 방어).

<!-- code: agent/Program.cs FROM "public void KeepOnTop" | 다시 맨 위로 올리기 -->
<details>
<summary>📄 실제 코드 — <code>agent/Program.cs</code> 171–174 · 다시 맨 위로 올리기</summary>

[GitHub에서 보기](../../agent/Program.cs#L171-L174)

```js
    public void KeepOnTop()
    {
        if (Visible && IsHandleCreated) Native.SetWindowPos(Handle, (IntPtr)(-1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010 | 0x0040);
    }
```

</details>
<!-- /code -->

### 2. 상태가 바뀐 "순간"만 알리기 (edge detection)

- **개념**: "지금 보는 사람이 N명이다"는 **상태**이고, "보는 사람이 생겼다"는 **사건**이다. 상태를 매번 알리면 1초마다 알림이 울린다. **이전 값과 비교해 달라진 순간에만** 알려야 한다.
- **이 코드에서는**: `Refresh()`가 1초마다 불리지만 `Alert(now)`가 `lastViewers`와 비교해 **늘어난 순간**(0→1, 1→2)에는 토스트+소리, **0이 된 순간**에는 "접속이 끝났어요" 토스트만 낸다. 같은 값이면 아무것도 안 한다.
- **주의할 점**: 같은 사람이 새로고침해서 순간적으로 0→1이 되면 알림이 또 울린다. 알림이 과하면 짧은 유예 시간을 두는 것이 다음 개선.

<!-- code: agent/Program.cs FROM "void Alert" | 달라진 순간에만 토스트·소리 -->
<details>
<summary>📄 실제 코드 — <code>agent/Program.cs</code> 234–245 · 달라진 순간에만 토스트·소리</summary>

[GitHub에서 보기](../../agent/Program.cs#L234-L245)

```js
    void Alert(int now)
    {
        int before = lastViewers; lastViewers = now;
        if (quiet || now == before) return;
        if (now > before)
        {
            tray.ShowBalloonTip(5000, "누군가 이 PC 화면을 보고 있어요", "지금 " + now + "명이 보는 중이에요. 트레이 아이콘에서 끌 수 있어요.", ToolTipIcon.Warning);
            System.Media.SystemSounds.Exclamation.Play();
        }
        else if (now == 0)
            tray.ShowBalloonTip(3000, "원격 접속이 끝났어요", "더 이상 이 PC 화면을 보는 사람이 없어요.", ToolTipIcon.Info);
    }
```

</details>
<!-- /code -->

### 3. 트레이 풍선 알림(토스트)과 시스템 소리

- **개념**: `NotifyIcon.ShowBalloonTip`은 Windows 10/11에서 오른쪽 아래 **토스트 알림**으로 나타난다. `SystemSounds.Exclamation.Play()`는 시스템 효과음 한 번.
- **주의할 점**: Windows **집중 지원(방해 금지)**이 켜져 있으면 토스트는 보이지 않고 알림 센터에만 쌓인다. 그래서 **소리를 같이** 낸다. 소리를 끄는 사용자 설정(음소거)까지는 못 막는다 — 그 한계를 문서에 남겼다.

### 4. 부작용을 끄는 스위치 `--quiet` — 시험하기 쉬운 설계

- **개념**: 소리·토스트처럼 **시험할 때마다 사람에게 닿는 부작용**은 끌 수 있는 스위치를 코드에 처음부터 둔다. 시험이 이 PC에서 소리를 낼 수는 없으니까.
- **이 코드에서는**: `--quiet`이면 알림과 소리만 끄고 **띠 유지는 그대로** 둔다(안전장치는 시험 중에도 실제와 같게 동작해야 하므로). 시험은 `--quiet`로 돌린다.
- **한계 (정직하게)**: `--quiet`로 돌리기 때문에 **토스트와 소리 자체는 자동 시험으로 확인하지 못했다.** 호출 위치와 조건은 코드로, 실제로 뜨고 울리는지는 직접 확인이 필요하다.

### 5. 시험이 아무것도 시험하지 않을 뻔한 사례

띠를 일부러 최상위에서 내리고 "다시 올라오는지" 보는 시험을 처음 이렇게 썼다.

```text
① 띠를 최상위에서 내린다 (PowerShell 호출)
② 별도 호출로 "내려갔나?" 확인   ← 실패!
③ 2.5초 기다린 뒤 "다시 올라왔나?" 확인  ← 통과
```

②가 실패했는데 ③은 통과했다. 원인은 ②를 별도 PowerShell 호출로 하는 동안(약 1초) **에이전트가 먼저 띠를 다시 올려 버린 것**이다. 이러면 ③의 통과는 "복구 기능이 동작한다"가 아니라 "원래 안 내려갔다"와 구별되지 않는다.

**고친 방법**: 내리는 것과 확인을 **같은 호출 안에서** 해서 "내린 직후엔 최상위가 아님"을 먼저 증명한 뒤, 기다려서 "다시 최상위"를 확인한다. 이제 두 단계가 모두 확인되므로 전이(내려감 → 올라옴)가 실제로 일어났다는 증거가 된다.

> 이 사례는 [이슈 #11 노트](2026-10-20-11-upload-retry.md)의 "시험이 아무것도 시험하지 않았던 일"과 같은 종류다 — **통과한 시험이 의도한 경로를 실제로 탔는지** 확인한다.

<!-- code: tests/remote-agent.test.js FROM "function topmost" | 내리는 것과 확인을 한 호출에서 -->
<details>
<summary>📄 실제 코드 — <code>tests/remote-agent.test.js</code> 24–27 · 내리는 것과 확인을 한 호출에서</summary>

[GitHub에서 보기](../../tests/remote-agent.test.js#L24-L27)

```js
function topmost(drop) {
  const script = `Add-Type 'using System;using System.Runtime.InteropServices;public class T{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);}'; $h=[T]::FindWindow([NullString]::Value,'text-tunnel-remote-banner'); if($h -eq [IntPtr]::Zero){'none';exit}; ${drop ? "[void][T]::SetWindowPos($h,[IntPtr](-2),0,0,0,0,0x0053);" : ''} if(([T]::GetWindowLong($h,-20) -band 8) -ne 0){'topmost'}else{'normal'}`;
  return execFileSync(PS, ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
}
```

</details>
<!-- /code -->

## 어떻게 시험했나

- `tests/remote-agent.test.js` 17항목(3번 반복 모두 통과): 띠가 최상위 → **일부러 내림(내린 직후 최상위 아님 확인)** → 2.5초 뒤 다시 최상위, 보는 쪽이 받는 신호는 `agent`·`frame` 두 종류뿐(알림이 보는 쪽으로 새지 않음)
- 시험은 `--quiet`로 돌려 이 PC에서 소리가 나지 않게 했다.

## 더 공부할 키워드·자료

- Win32 `SetWindowPos`, `HWND_TOPMOST`, `SWP_NOACTIVATE`, 창 확장 스타일 `WS_EX_TOPMOST`
- 독점 전체 화면(exclusive fullscreen)과 테두리 없는 전체 화면(borderless)의 차이
- Windows 알림: 토스트 알림, 집중 지원(Focus Assist), `Shell_NotifyIcon`
- 이벤트와 상태: edge-triggered vs level-triggered
- 시험 가능한 설계: 부작용 스위치, 의존성 주입

## 스스로 확인

<details><summary>1. `TopMost = true`인 창이 덮이는 이유는?</summary>

TOPMOST 층 안에서도 창끼리 쌓이는 순서가 있어서, 나중에 맨 위로 올린 다른 TOPMOST 창이 위에 온다. 그래서 주기적으로 다시 올려야 한다.
</details>

<details><summary>2. 알림을 "상태"가 아니라 "달라진 순간"에만 내는 이유는?</summary>

상태를 그대로 알리면 1초마다 같은 알림이 울려서 쓸모가 없어진다. 이전 값과 비교해 변할 때만 알려야 알림이 의미를 갖는다.
</details>

<details><summary>3. `--quiet`가 띠 유지까지 끄지 않는 이유는?</summary>

안전장치는 시험 중에도 실제와 똑같이 동작해야 시험이 의미가 있다. 끄는 것은 사람에게 닿는 부작용(소리·토스트)뿐이다.
</details>

<details><summary>4. 처음 쓴 복구 시험은 왜 의미가 없었고, 어떻게 고쳤나?</summary>

내린 상태를 별도 호출로 확인하는 사이 에이전트가 먼저 복구해 버려서, 복구 기능과 "원래 안 내려갔음"을 구별할 수 없었다. 내리는 것과 확인을 한 호출에서 해 "내린 직후 상태"를 먼저 증명했다.
</details>
