package dev.esstional.texttunnel.phone

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * 설정 화면. 순서대로: 서버 → 짝 맺기(앱의 "새 기기 연결" 코드) → 접속 PIN → 화면 공유(원격 허용) → 조종 허용.
 * 이 화면 자체는 최소한으로 — 모든 색·글자는 시스템 기본이라 라이트/다크를 따른다.
 */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var statusView: TextView
    private lateinit var serverEdit: EditText
    private lateinit var codeEdit: EditText
    private lateinit var pairInfo: TextView
    private lateinit var pinInfo: TextView
    private lateinit var shareSwitch: Switch
    private lateinit var controlSwitch: Switch
    private lateinit var controlInfo: TextView
    private var settingSwitches = false
    private var testCount = 0

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun label(text: String, size: Float = 14f, bold: Boolean = false, top: Int = 12) = TextView(this).apply {
        this.text = text; textSize = size
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(0, dp(top), 0, dp(2))
    }

    private fun button(text: String, onClick: () -> Unit) = Button(this).apply { this.text = text; setOnClickListener { onClick() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(24), dp(20), dp(32)) }

        col.addView(label("Text Tunnel 폰", 24f, true, 0))
        col.addView(label("PC 에서 이 폰 화면을 보고 조종할 수 있게 하는 앱이에요.", 14f))
        statusView = label("", 15f, true, 14)
        col.addView(statusView)

        if (BuildConfig.DEBUG) { // 시험용: 탭·글자가 실제로 들어왔는지 확인하는 칸 (디버그 빌드에만 보임, 화면 맨 위에 둬서 스크롤 없이 보이게)
            col.addView(Button(this).apply {
                text = "탭 시험 (0)"; contentDescription = "tap-test"
                setOnClickListener { testCount++; text = "탭 시험 ($testCount)"; Log.i("TT_TEST", "tap count=$testCount") }
                setOnLongClickListener { Log.i("TT_TEST", "long press"); true }
            })
            col.addView(EditText(this).apply { hint = "글자 입력 시험"; contentDescription = "text-test"; setSingleLine() })
        }

        col.addView(label("1. 서버", 16f, true, 20))
        serverEdit = EditText(this).apply { setText(prefs.server); inputType = InputType.TYPE_TEXT_VARIATION_URI; setSingleLine() }
        col.addView(serverEdit)

        col.addView(label("2. 짝 맺기", 16f, true, 20))
        col.addView(label("메신저 앱 메뉴 → 새 기기 연결 에서 받은 6자리 코드를 입력하세요 (5분 안에 한 번만 쓸 수 있어요).", 13f, false, 2))
        codeEdit = EditText(this).apply { hint = "6자리 코드"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS; setSingleLine() }
        col.addView(codeEdit)
        col.addView(button("짝 맺기") { pair(codeEdit.text.toString().trim().uppercase()) })
        pairInfo = label("", 13f, false, 2); col.addView(pairInfo)

        col.addView(label("3. 접속 PIN", 16f, true, 20))
        col.addView(label("이 PIN 을 아는 사람만 이 폰 화면을 볼 수 있어요. PIN 을 정하기 전에는 아무도 볼 수 없어요. 6~12자리 숫자.", 13f, false, 2))
        col.addView(button("PIN 정하기·바꾸기") { askPin() })
        pinInfo = label("", 13f, false, 2); col.addView(pinInfo)

        col.addView(label("4. 화면 공유 (원격 허용)", 16f, true, 20))
        col.addView(label("켜면 안드로이드가 허용 창을 띄워요. 켜져 있는 동안 알림이 항상 떠 있고, 알림의 '중지'로 언제든 끌 수 있어요. 보는 사람이 없으면 화면을 찍지도 보내지도 않아요.", 13f, false, 2))
        shareSwitch = Switch(this).apply { text = "화면 공유 켜기"; setPadding(0, dp(8), 0, dp(8)) }
        shareSwitch.setOnCheckedChangeListener { _, on -> if (!settingSwitches) onShareToggle(on) }
        col.addView(shareSwitch)

        col.addView(label("5. 조종 허용 (선택)", 16f, true, 20))
        controlInfo = label("", 13f, false, 2); col.addView(controlInfo)
        controlSwitch = Switch(this).apply { text = "PC 에서 터치·글자 입력 허용"; setPadding(0, dp(8), 0, dp(8)) }
        controlSwitch.setOnCheckedChangeListener { _, on -> if (!settingSwitches) onControlToggle(on) }
        col.addView(controlSwitch)
        col.addView(button("접근성 설정 열기") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })

        col.addView(label("PC(또는 다른 폰)의 메신저 앱 메뉴 → 원격 화면 보기 → PIN 입력으로 이 폰 화면을 볼 수 있어요. 은행 앱 등 보안 화면은 안드로이드가 검게 처리해요.", 12f, false, 20))

        setContentView(ScrollView(this).apply { addView(col) })
        handleDebugExtras(intent)
        handleLink(intent)
        tick()
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleDebugExtras(intent); handleLink(intent) }

    // ── 웹의 "휴대폰 원격 연결하기" 링크 (이슈 #48) ──
    // texttunnel://connect?code=6자리&server=서버주소 → 자동으로 짝 맺기 → (PIN 이 없으면 정하기) → 화면 공유 허용 요청 → 원격 지원 켜짐
    private fun handleLink(i: Intent?) {
        val data = i?.data ?: return
        if (data.scheme != "texttunnel" || data.host != "connect") return
        i.data = null // 한 번만 처리 (화면 회전·다시 열기에서 같은 링크를 또 처리하지 않게)
        if (AgentService.running) { toast("이미 원격 연결 중이에요"); return }
        val code = (data.getQueryParameter("code") ?: "").trim().uppercase()
        val server = data.getQueryParameter("server")?.trim()?.trimEnd('/')
        if (!Regex("^[A-Z0-9]{6}$").matches(code)) { toast("연결 링크가 올바르지 않아요"); return }
        if (server != null && !(server.startsWith("https://") || (BuildConfig.DEBUG && server.startsWith("http://")))) { toast("연결 링크의 서버 주소가 올바르지 않아요"); return }
        val go = { if (server != null) { prefs.server = server; serverEdit.setText(prefs.server) }; autoConnect(code) }
        // 저장돼 있던 서버·기본 서버가 아니면 한 번 물어본다 (아무 웹페이지가 이 링크로 폰 화면을 엉뚱한 서버에 보내지 못하게)
        if (server != null && server != prefs.server && server != Prefs.DEFAULT_SERVER) {
            AlertDialog.Builder(this).setTitle("이 서버로 연결할까요?")
                .setMessage("$server\n\n내가 쓰는 서버가 아니면 '취소'를 누르세요.")
                .setPositiveButton("연결") { _, _ -> go() }.setNegativeButton("취소", null).show()
        } else go()
    }

    /** 코드로 짝을 맺고 → PIN → 화면 공유까지 이어서 진행한다 */
    private fun autoConnect(code: String) {
        Thread {
            val msg = try {
                val r = Http(prefs.server).postJson("/api/pair/claim", JSONObject().put("code", code))
                val key = r.json()?.optString("key", "") ?: ""
                if (r.ok && key.isNotEmpty()) { prefs.key = key; AgentService.log(this, "짝을 맺었어요 (연결 링크)"); null }
                else "연결 코드가 만료됐거나 맞지 않아요. 메신저에서 \"휴대폰 원격 연결하기\"를 다시 눌러 주세요"
            } catch (e: Exception) { "서버에 연결하지 못했어요" }
            ui.post { if (msg != null) toast(msg) else continueSetup() }
        }.start()
    }

    private fun continueSetup() {
        refresh()
        if (!prefs.paired) return
        if (!prefs.hasPin) { toast("먼저 접속 PIN 을 정해 주세요"); askPin { continueSetup() }; return }
        if (!AgentService.running) onShareToggle(true)
    }
    override fun onResume() { super.onResume(); refresh() }

    private fun tick() { refresh(); ui.postDelayed({ tick() }, 1000) }
    override fun onDestroy() { ui.removeCallbacksAndMessages(null); super.onDestroy() }

    // ── 화면 갱신 ──
    private fun refresh() {
        statusView.text = when {
            AgentService.running -> "● 화면 공유 중 — ${AgentService.state}"
            else -> "○ 꺼져 있어요"
        }
        pairInfo.text = if (prefs.paired) "✓ 짝 맺기 완료" else "아직 짝을 맺지 않았어요"
        pinInfo.text = if (prefs.hasPin) "✓ PIN 이 정해져 있어요" else "아직 PIN 이 없어요 — 정하기 전에는 아무도 볼 수 없어요"
        controlInfo.text = if (TunnelAccessibilityService.enabled) "✓ 접근성 서비스가 켜져 있어요" else "접근성 서비스가 꺼져 있어요 — 설정 → 접근성 → 설치된 앱 → Text Tunnel 폰 조종 을 켜세요 (안드로이드 13+ 는 앱 정보 → ⋮ → 제한된 설정 허용 을 먼저 해야 켤 수 있어요)"
        settingSwitches = true
        shareSwitch.isChecked = AgentService.running
        controlSwitch.isChecked = prefs.control
        settingSwitches = false
    }

    // ── 짝 맺기 ──
    private fun pair(code: String) {
        if (!Regex("^[A-Z0-9]{6}$").matches(code)) { toast("6자리 코드를 입력하세요"); return }
        prefs.server = serverEdit.text.toString()
        Thread {
            val msg = try {
                val r = Http(prefs.server).postJson("/api/pair/claim", JSONObject().put("code", code))
                val key = r.json()?.optString("key", "") ?: ""
                if (r.ok && key.isNotEmpty()) { prefs.key = key; AgentService.log(this, "짝을 맺었어요"); "짝 맺기 완료" }
                else "코드가 맞지 않거나 만료됐어요 (${r.code})"
            } catch (e: Exception) { "서버에 연결하지 못했어요" }
            ui.post { toast(msg); refresh() }
        }.start()
    }

    // ── PIN ──
    private fun askPin(onSaved: (() -> Unit)? = null) {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0) }
        fun field(hint: String) = EditText(this).apply { this.hint = hint; inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD; filters = arrayOf(android.text.InputFilter.LengthFilter(12)) }
        val a = field("PIN (6~12자리 숫자)"); val b = field("한 번 더")
        box.addView(a); box.addView(b)
        AlertDialog.Builder(this).setTitle("접속 PIN").setView(box)
            .setPositiveButton("저장") { _, _ ->
                val p = a.text.toString()
                when {
                    !PinStore.valid(p) -> toast("PIN 은 6~12자리 숫자예요")
                    p != b.text.toString() -> toast("두 번 입력한 PIN 이 달라요")
                    else -> { PinStore.set(prefs, p); AgentService.log(this, "PIN 을 새로 정했어요"); toast("PIN 을 저장했어요"); refresh(); onSaved?.invoke() }
                }
            }.setNegativeButton("취소", null).show()
    }

    // ── 화면 공유 ──
    private fun onShareToggle(on: Boolean) {
        if (!on) { startService(Intent(this, AgentService::class.java).setAction(AgentService.ACTION_STOP)); return }
        when {
            !prefs.paired -> { toast("먼저 짝을 맺어 주세요"); refresh(); return }
            !prefs.hasPin -> { toast("먼저 접속 PIN 을 정해 주세요"); refresh(); return }
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF); return // 허용 후 다시 켜기
        }
        requestProjection()
    }

    private fun requestProjection() {
        prefs.server = serverEdit.text.toString()
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return
        if (resultCode == RESULT_OK && data != null) {
            startForegroundService(Intent(this, AgentService::class.java).setAction(AgentService.ACTION_START)
                .putExtra(AgentService.EXTRA_CODE, resultCode).putExtra(AgentService.EXTRA_DATA, data))
            toast("원격 연결이 켜졌어요 — 컴퓨터의 \"원격 화면 보기\"에서 이 폰을 볼 수 있어요")
        } else toast("화면 공유를 허용하지 않았어요")
        ui.postDelayed({ refresh() }, 500)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF) { if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) requestProjection() else { toast("알림을 허용해야 화면 공유 중 표시를 보여 줄 수 있어요"); refresh() } }
    }

    // ── 조종 ──
    private fun onControlToggle(on: Boolean) {
        if (on && !TunnelAccessibilityService.enabled) {
            AlertDialog.Builder(this).setTitle("접근성 서비스를 켜 주세요")
                .setMessage("PC 에서 터치·글자를 넣으려면 접근성 서비스가 필요해요.\n\n설정 → 접근성 → 설치된 앱 → \"Text Tunnel 폰 조종\" 을 켜세요.\n안드로이드 13 이상에서 켜지지 않으면 앱 정보 → ⋮ → \"제한된 설정 허용\" 을 먼저 하세요.\n\n켠 뒤 돌아와서 이 스위치를 다시 켜면 됩니다.")
                .setPositiveButton("접근성 설정 열기") { _, _ -> startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
                .setNegativeButton("취소", null).show()
            refresh(); return
        }
        prefs.control = on
        AgentService.log(this, if (on) "조종 허용을 켰어요" else "조종 허용을 껐어요")
        AgentService.refreshControl()
        refresh()
    }

    // ── 디버그 자동화: adb 로 설정·시작 (디버그 빌드에서만) ──
    private fun handleDebugExtras(i: Intent?) {
        if (!BuildConfig.DEBUG || i == null) return
        i.getStringExtra("server")?.let { prefs.server = it; serverEdit.setText(prefs.server) }
        i.getStringExtra("pin")?.let { if (PinStore.valid(it)) PinStore.set(prefs, it) }
        if (i.hasExtra("control")) { prefs.control = i.getBooleanExtra("control", false); AgentService.refreshControl() }
        i.getStringExtra("code")?.let { pair(it) }
        if (i.getBooleanExtra("share", false)) ui.postDelayed({ onShareToggle(true) }, 1500)
        refresh()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    companion object {
        private const val REQ_PROJECTION = 1
        private const val REQ_NOTIF = 2
    }
}
