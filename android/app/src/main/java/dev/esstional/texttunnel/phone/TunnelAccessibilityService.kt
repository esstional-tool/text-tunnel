package dev.esstional.texttunnel.phone

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * 원격으로 들어온 입력을 이 폰에 넣는다 (접근성 서비스 — 사용자가 설정에서 직접 켜야 함).
 *
 * PC 보는 화면은 마우스 이벤트(m 이동·d 누름·u 뗌·w 휠)와 키·글자(k·s)·이동 동작(n)을 보낸다. 여기서 터치로 번역한다:
 *  · 왼쪽 버튼 누르고 뗌   → 거의 안 움직였으면 탭(0.5초 이상이면 길게 누르기), 움직였으면 스와이프(드래그)
 *  · 오른쪽 버튼           → 뒤로        · 가운데 버튼 → 홈
 *  · 휠                   → 화면 스크롤(스와이프)
 *  · 글자(ch)·글자 보내기(s) → 포커스가 있는 입력칸의 커서 위치에 넣기 (한글은 PC 의 "글자 보내기" 칸으로)
 *  · 뒤로·홈·최근·알림      → 전역 동작
 * 화면 내용을 읽어 저장하지 않는다 (입력칸을 찾아 글자를 넣는 데만 쓴다).
 */
class TunnelAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile var instance: TunnelAccessibilityService? = null
        val enabled: Boolean get() = instance != null
        private const val LONG_PRESS_MS = 500L
    }

    private val main = Handler(Looper.getMainLooper())
    private var down = false
    private var downAt = 0L
    private val pts = ArrayList<FloatArray>()

    // 접근성 서비스가 켜지고 꺼지는 순간 바로 서버에 "조종 가능/불가"를 알린다 (3초 주기 확인을 기다리지 않고)
    override fun onServiceConnected() { instance = this; AgentService.refreshControl() }
    override fun onUnbind(intent: android.content.Intent?): Boolean { instance = null; AgentService.refreshControl(); return super.onUnbind(intent) }
    override fun onDestroy() { if (instance === this) { instance = null; AgentService.refreshControl() }; super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    /** 서버가 전달한 입력 묶음을 순서대로 적용한다 (메인 스레드에서) */
    fun apply(events: JSONArray) {
        main.post {
            for (i in 0 until events.length()) {
                try { one(events.getJSONObject(i)) } catch (e: Exception) { if (BuildConfig.DEBUG) Log.w("TT_GESTURE", "input error: $e") }
            }
        }
    }

    /** 누르고 있던 것을 모두 놓는다 (조종이 꺼지거나 연결이 끊길 때) */
    fun releaseAll() { main.post { down = false; pts.clear() } }

    private fun size(): IntArray {
        val m = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
        return intArrayOf(m.widthPixels, m.heightPixels)
    }

    private fun xy(e: JSONObject): FloatArray {
        val s = size()
        return floatArrayOf(
            (e.optDouble("x", 0.5).coerceIn(0.0, 1.0) * (s[0] - 1)).toFloat(),
            (e.optDouble("y", 0.5).coerceIn(0.0, 1.0) * (s[1] - 1)).toFloat(),
        )
    }

    private fun one(e: JSONObject) {
        when (e.optString("t")) {
            "m" -> if (down && pts.size < 400) pts.add(xy(e))
            "d" -> when (e.optInt("b")) {
                0 -> { down = true; downAt = SystemClock.uptimeMillis(); pts.clear(); pts.add(xy(e)) }
                2 -> { val r = performGlobalAction(GLOBAL_ACTION_BACK); if (BuildConfig.DEBUG) Log.i("TT_GESTURE", "back(right button) ok=$r") }   // 오른쪽 버튼 = 뒤로
                1 -> performGlobalAction(GLOBAL_ACTION_HOME)   // 가운데 버튼 = 홈
            }
            "u" -> if (e.optInt("b") == 0 && down) { pts.add(xy(e)); finishTouch() }
            "w" -> scroll(e.optInt("dx"), e.optInt("dy"))
            "k" -> key(e)
            "n" -> nav(e.optString("a"))
            "s" -> insert(e.optString("s"))
            "r" -> { down = false; pts.clear() }
        }
    }

    // ── 터치 ───────────────────────────────────
    private fun finishTouch() {
        val dur = SystemClock.uptimeMillis() - downAt
        val first = pts.first()
        val maxDist = pts.maxOf { hypot(it[0] - first[0], it[1] - first[1]) }
        val slop = 12f * resources.displayMetrics.density // 손가락이 이 정도 안 움직이면 탭
        if (maxDist < slop) {
            if (dur >= LONG_PRESS_MS) hold(first[0], first[1], min(max(dur, 600L), 2000L)) else hold(first[0], first[1], 60L)
        } else {
            swipe(pts, min(max(dur, 120L), 1500L))
        }
        down = false; pts.clear()
    }

    private fun hold(x: Float, y: Float, ms: Long) {
        stroke(Path().apply { moveTo(x, y) }, ms, if (ms >= LONG_PRESS_MS) "long ${x.toInt()},${y.toInt()}" else "tap ${x.toInt()},${y.toInt()}")
    }

    private fun swipe(points: List<FloatArray>, ms: Long) {
        val path = Path()
        val step = max(1, points.size / 25) // 너무 많은 점은 솎아 낸다
        path.moveTo(points[0][0], points[0][1])
        var i = step
        while (i < points.size) { path.lineTo(points[i][0], points[i][1]); i += step }
        path.lineTo(points.last()[0], points.last()[1])
        stroke(path, ms, "swipe ${points[0][0].toInt()},${points[0][1].toInt()} -> ${points.last()[0].toInt()},${points.last()[1].toInt()}")
    }

    private fun scroll(dx: Int, dy: Int) {
        val s = size()
        val cx = s[0] / 2f; val cy = s[1] / 2f
        // 브라우저 휠: 아래로(+) = 내용이 위로 올라감 = 손가락은 위로 민다
        val d = min(max(abs(dy) * 2.5f, 150f), s[1] * 0.6f)
        val path = Path()
        if (dy != 0) { val dir = if (dy > 0) -1 else 1; path.moveTo(cx, cy - dir * d / 2); path.lineTo(cx, cy + dir * d / 2) }
        else if (dx != 0) { val dir = if (dx > 0) -1 else 1; path.moveTo(cx - dir * d / 2, cy); path.lineTo(cx + dir * d / 2, cy) }
        else return
        stroke(path, 250L, "scroll dx=$dx dy=$dy")
    }

    private fun stroke(path: Path, ms: Long, what: String) {
        if (BuildConfig.DEBUG) Log.i("TT_GESTURE", what) // 디버그 빌드만: 시험이 "어떤 동작을 넣었는지" 확인하려고 (좌표만, 화면 내용 아님)
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, max(1L, ms))).build()
        dispatchGesture(g, null, null)
    }

    // ── 이동 동작 ───────────────────────────────
    private fun nav(a: String) {
        when (a) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
        }
    }

    // ── 글자 ───────────────────────────────────
    private fun key(e: JSONObject) {
        if (e.optInt("d") == 0) return // 누를 때만 (뗄 때는 무시)
        val ch = e.optString("ch", "")
        if (ch.isNotEmpty()) { insert(ch); return }
        when (e.optInt("vk")) {
            8 -> backspace()
            13 -> enter()
            27 -> performGlobalAction(GLOBAL_ACTION_BACK) // Esc = 뒤로
        }
    }

    private fun focusedInput(): AccessibilityNodeInfo? = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

    /** 글자를 포커스가 있는 입력칸의 커서(선택 영역) 위치에 넣는다 */
    private fun insert(text: String): Boolean {
        if (text.isEmpty()) return false
        val node = focusedInput()
        if (BuildConfig.DEBUG) Log.i("TT_GESTURE", "insert len=${text.length} focus=${node != null}")
        if (node == null) return false
        val cur = if (node.isShowingHintText) "" else (node.text?.toString() ?: "")
        val (a, b) = selection(node, cur)
        val next = cur.substring(0, a) + text + cur.substring(b)
        setText(node, next, a + text.length)
        return true
    }

    private fun backspace() {
        val node = focusedInput() ?: return
        val cur = if (node.isShowingHintText) "" else (node.text?.toString() ?: "")
        val (a, b) = selection(node, cur)
        if (a < b) { setText(node, cur.substring(0, a) + cur.substring(b), a); return }
        if (a == 0) return
        val prev = if (a >= 2 && Character.isLowSurrogate(cur[a - 1]) && Character.isHighSurrogate(cur[a - 2])) a - 2 else a - 1
        setText(node, cur.substring(0, prev) + cur.substring(a), prev)
    }

    private fun enter() {
        val node = focusedInput() ?: return
        if (Build.VERSION.SDK_INT >= 30) node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        else if (node.isMultiLine) insert("\n")
    }

    private fun selection(node: AccessibilityNodeInfo, cur: String): Pair<Int, Int> {
        var s = node.textSelectionStart; var e = node.textSelectionEnd
        if (s < 0 || e < 0 || s > cur.length || e > cur.length) { s = cur.length; e = cur.length }
        return Pair(min(s, e), max(s, e))
    }

    private fun setText(node: AccessibilityNodeInfo, text: String, cursor: Int) {
        node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        })
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        })
    }
}
