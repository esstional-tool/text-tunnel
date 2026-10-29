package dev.esstional.texttunnel.phone

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.text.SimpleDateFormat
import java.util.Arrays
import java.util.Date
import java.util.Locale

/**
 * 폰 에이전트: 서버에 짝 열쇠로 입장해 "보는 사람" 알림을 받고, 보는 사람이 있을 때만 화면을 캡처해 보낸다.
 * PC 에이전트(agent/Program.cs)와 같은 프로토콜이다 — 입장 → SSE(viewers·auth·input·profile) → 프레임 POST.
 *
 * 안전장치
 *  · 화면 공유 중에는 알림이 항상 떠 있고 "중지"·"조종 끄기" 단추가 있다 (+ 안드로이드의 화면 공유 표시)
 *  · PIN 은 이 폰의 주인이 정하고 이 폰이 직접 확인한다. 5번 틀리면 10분 잠금
 *  · 조종(터치 주입)은 별도 허용(기본 꺼짐) + 접근성 서비스가 켜져 있을 때만, PIN 을 이 폰이 확인해 준 사람의 입력만
 *  · 보는 사람이 없으면 화면을 찍지도 보내지도 않는다
 *  · 접속 성공·실패·조종 시작/끝은 access.log 에 (PIN·열쇠·화면·입력 내용은 기록하지 않음)
 */
class AgentService : Service() {
    companion object {
        const val ACTION_START = "dev.esstional.texttunnel.phone.START"
        const val ACTION_STOP = "dev.esstional.texttunnel.phone.STOP"
        const val ACTION_PANIC = "dev.esstional.texttunnel.phone.PANIC"
        const val EXTRA_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        private const val CH_STATUS = "status"
        private const val CH_ALERT = "alert"
        private const val NOTIF_ID = 1
        private const val ALERT_ID = 2
        private const val MAX_FAILS = 5
        private const val LOCK_MS = 10 * 60 * 1000L

        @Volatile var running = false
        @Volatile var viewers = 0
        @Volatile var controllers = 0
        @Volatile var state = "꺼짐"
        @Volatile private var instance: AgentService? = null

        /** 조종 허용 상태가 바뀌었음을 서버에 알린다 (앱 화면의 스위치·접근성 서비스 on/off 후) */
        fun refreshControl() { instance?.reportControl() }

        fun log(ctx: Context, text: String) {
            try {
                val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.KOREA).format(Date())
                File(ctx.filesDir, "access.log").appendText("$stamp  $text\n")
            } catch (_: Exception) {}
        }
    }

    private lateinit var prefs: Prefs
    private var http: Http? = null
    private var projection: MediaProjection? = null
    private var capture: ScreenCapture? = null
    private val ui = Handler(Looper.getMainLooper())
    private var wake: PowerManager.WakeLock? = null

    @Volatile private var token: String? = null
    @Volatile private var events: HttpURLConnection? = null
    private val authed = HashSet<String>() // 이 폰이 PIN 을 확인해 통과시킨 보는 사람들 (입력은 이들만)
    private var pinFails = 0
    private var lockedUntil = 0L
    @Volatile private var controlReported = false
    @Volatile private var lastReported: Boolean? = null
    @Volatile private var pendingProfile: String? = null
    private var lastViewers = 0
    private var lastControllers = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopAll("알림의 중지"); return START_NOT_STICKY }
            ACTION_PANIC -> { panic("알림의 조종 끄기"); return START_NOT_STICKY }
            ACTION_START -> startAgent(intent)
        }
        return START_NOT_STICKY // 화면 공유 허용은 서비스가 죽으면 사라지므로 시스템이 몰래 다시 켜지 않게 한다
    }

    // ── 시작·종료 ─────────────────────────────
    private fun startAgent(intent: Intent) {
        if (running) return
        prefs = Prefs(this)
        createChannels()
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(NOTIF_ID, n)
        val code = intent.getIntExtra(EXTRA_CODE, Activity.RESULT_CANCELED)
        @Suppress("DEPRECATION")
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_DATA, Intent::class.java) else intent.getParcelableExtra(EXTRA_DATA)
        if (code != Activity.RESULT_OK || data == null || prefs.key == null) { stopAll("시작 조건 부족"); return }
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val p = mpm.getMediaProjection(code, data)
        p.registerCallback(object : MediaProjection.Callback() { // 안드로이드 14+: 가상 화면을 만들기 전에 등록해야 한다. 사용자가 시스템에서 공유를 끄면 우리도 끝낸다
            override fun onStop() { ui.post { stopAll("시스템에서 화면 공유 중지") } }
        }, ui)
        projection = p
        capture = ScreenCapture(this, p)
        instance = this
        running = true
        state = "연결 중…"
        log(this, "화면 공유를 시작했어요")
        Thread({ connectLoop() }, "tt-connect").start()
        Thread({ captureLoop() }, "tt-capture-loop").start()
        update()
    }

    private fun stopAll(why: String) {
        if (!running && projection == null) { stopSelf(); return }
        running = false
        log(this, "화면 공유를 끝냈어요 ($why)")
        try { events?.disconnect() } catch (_: Exception) {}
        val t = token; val h = http
        if (t != null && h != null) Thread { h.leave(t) }.start()
        TunnelAccessibilityService.instance?.releaseAll()
        capture?.release(); capture = null
        try { projection?.stop() } catch (_: Exception) {}
        projection = null
        viewers = 0; controllers = 0; state = "꺼짐"
        try { wake?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        instance = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(ALERT_ID)
        stopSelf()
    }

    override fun onDestroy() { if (running) stopAll("서비스 종료"); super.onDestroy() }

    /** 즉시 중지: 조종 허용을 끄고 눌려 있던 것을 놓는다 (화면 보기는 그대로) */
    private fun panic(why: String) {
        prefs = Prefs(this)
        prefs.control = false
        TunnelAccessibilityService.instance?.releaseAll()
        log(this, "조종 즉시 중지 ($why)")
        reportControl()
        update()
    }

    // ── 서버 연결 ─────────────────────────────
    private fun connectLoop() {
        while (running) {
            try {
                val key = prefs.key ?: break
                val h = Http(prefs.server); http = h
                val r = h.postJson("/api/remote/agent/join", JSONObject().put("key", key).put("name", Build.MODEL ?: "휴대폰").put("platform", "android"))
                if (!r.ok) throw IOException("join ${r.code}")
                token = r.json()!!.getString("token")
                controlReported = false; lastReported = null
                synchronized(authed) { authed.clear() }
                state = "연결됨 — 대기 중"; update()
                val c = h.openEvents(token!!); events = c
                h.readEvents(c) { ev -> onEvent(ev) }
            } catch (_: Exception) {}
            viewers = 0; controllers = 0; token = null
            synchronized(authed) { authed.clear() }
            TunnelAccessibilityService.instance?.releaseAll()
            if (running) { state = "서버에 다시 연결하는 중…"; update() }
            var i = 0
            while (running && i < 20) { Thread.sleep(100); i++ }
        }
    }

    private fun onEvent(ev: JSONObject) {
        when (ev.optString("type")) {
            "viewers" -> {
                val n = ev.optInt("count"); val c = ev.optInt("controllers")
                if (c < controllers) TunnelAccessibilityService.instance?.releaseAll() // 한 명이라도 조종을 끄면 누르고 있던 것을 놓는다
                viewers = n; controllers = c
                state = if (n == 0) "연결됨 — 대기 중" else "$n 명이 보고 있어요" + if (c > 0 && prefs.control) " (조종 중)" else ""
                if (n > lastViewers) alertViewer(n)
                if (c > 0 && lastControllers == 0) log(this, "조종 시작 ($c 명)") else if (c == 0 && lastControllers > 0) log(this, "조종 끝")
                lastViewers = n; lastControllers = c
                update()
                if (!controlReported) { controlReported = true; reportControl() }
            }
            "auth" -> {
                val vid = ev.optString("vid"); val pin = ev.optString("pin")
                Thread { handleAuth(vid, pin) }.start() // PBKDF2 는 느리므로 알림 수신을 막지 않게 따로
            }
            "input" -> {
                val vid = ev.optString("vid")
                val known = synchronized(authed) { authed.contains(vid) }
                // 조종이 허용되어 있고(주인이 켬) 접근성 서비스가 켜져 있고, 이 폰이 PIN 을 확인해 준 사람의 입력만 (서버를 믿지 않고 여기서도 확인)
                if (running && prefs.control && controllers > 0 && known) TunnelAccessibilityService.instance?.apply(ev.getJSONArray("ev"))
            }
            "profile" -> pendingProfile = ev.optString("mode")
        }
    }

    private fun handleAuth(vid: String, pin: String) {
        val t = token ?: return
        val h = http ?: return
        val reply = JSONObject().put("vid", vid)
        val now = System.currentTimeMillis()
        if (!prefs.hasPin) {
            reply.put("ok", false).put("code", "no-pin"); log(this, "접속 거절: PIN 을 아직 정하지 않았어요")
        } else if (now < lockedUntil) {
            reply.put("ok", false).put("code", "locked").put("locked", true).put("lockedUntil", lockedUntil); log(this, "접속 거절: 잠금 중")
        } else if (PinStore.check(prefs, pin)) {
            pinFails = 0; synchronized(authed) { authed.add(vid) }
            reply.put("ok", true); log(this, "접속 성공")
        } else {
            pinFails++
            reply.put("ok", false).put("code", "wrong").put("left", maxOf(0, MAX_FAILS - pinFails))
            if (pinFails >= MAX_FAILS) {
                lockedUntil = now + LOCK_MS; pinFails = 0
                reply.put("code", "locked").put("locked", true).put("lockedUntil", lockedUntil).put("left", 0)
                log(this, "접속 실패: PIN 을 ${MAX_FAILS}번 틀려 10분간 잠금")
            } else log(this, "접속 실패: PIN 이 틀렸어요")
            alertWrongPin()
        }
        try { h.postJson("/api/remote/agent/auth?token=${java.net.URLEncoder.encode(t, "UTF-8")}", reply) } catch (_: Exception) {}
    }

    /** 서버에 "이 폰은 조종을 허용한다/아니다" 를 알린다. 주인이 켰고 접근성 서비스도 켜져 있을 때만 허용 */
    fun reportControl() {
        val t = token ?: return
        val h = http ?: return
        val allowed = prefs.control && TunnelAccessibilityService.enabled
        if (lastReported == allowed) return
        Thread {
            try {
                h.postJson("/api/remote/agent/control?token=${java.net.URLEncoder.encode(t, "UTF-8")}", JSONObject().put("allowed", allowed))
                lastReported = allowed
            } catch (_: Exception) {}
        }.start()
    }

    // ── 화면 보내기 ───────────────────────────
    private class Profile(val maxWidth: Int, val minQ: Int, val maxQ: Int, val startQ: Int, val minInterval: Int)

    private fun profileOf(mode: String) = when (mode) {
        "quality" -> Profile(1080, 60, 90, 80, 250)
        "speed" -> Profile(480, 25, 50, 40, 100)
        else -> Profile(720, 30, 80, 55, 150)
    }

    /** 보는 사람이 있을 때만 화면을 찍는다. 바뀌지 않았으면 보내지 않고(10초마다만 한 장), 느리면 화질·빈도를 스스로 낮춘다 */
    private fun captureLoop() {
        var prof = profileOf("auto")
        var quality = prof.startQ
        var interval = 250
        var ema = 0.0
        var prev: IntArray? = null
        var cur = IntArray(0)
        var lastSent = 0L
        var lastCheck = 0L
        while (running) {
            val t = token; val cap = capture; val h = http
            if (cap == null || h == null) { Thread.sleep(200); continue }
            val nowMs = System.currentTimeMillis()
            if (nowMs - lastCheck > 3000) { lastCheck = nowMs; reportControl() } // 접근성 서비스를 켜고 끈 것을 따라간다
            if (viewers == 0 || t == null) { prev = null; Thread.sleep(200); continue }
            val pp = pendingProfile
            if (pp != null) { pendingProfile = null; prof = profileOf(pp); quality = prof.startQ; interval = maxOf(250, prof.minInterval); prev = null; ema = 0.0 }
            try {
                cap.configure(prof.maxWidth)
                val bmp = cap.grab()
                if (bmp == null) { Thread.sleep(60); continue }
                val w = bmp.width; val hh = bmp.height
                if (cur.size != w * hh) cur = IntArray(w * hh)
                bmp.getPixels(cur, 0, w, 0, 0, w, hh)
                val p = prev
                val changed = p == null || p.size != cur.size || !Arrays.equals(p, cur) || nowMs - lastSent > 10_000
                if (changed) {
                    val out = ByteArrayOutputStream(64 * 1024)
                    bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality, out)
                    val t0 = System.currentTimeMillis()
                    var slow = false
                    var ok = true
                    try {
                        val r = h.postFrame(t, out.toByteArray(), w, hh)
                        slow = r.body.endsWith(" slow")
                        ok = r.ok
                    } catch (_: Exception) { ok = false }
                    val ms = (System.currentTimeMillis() - t0).toDouble()
                    ema = if (ema == 0.0) ms else ema * 0.6 + ms * 0.4
                    if (!ok || slow || ema > 700) { quality = maxOf(prof.minQ, quality - 10); interval = minOf(600, interval + 80) }
                    else if (ema < 250) { quality = minOf(prof.maxQ, quality + 4); interval = maxOf(prof.minInterval, interval - 20) }
                    if (ok) { prev = cur.copyOf(); lastSent = System.currentTimeMillis() }
                }
            } catch (_: Exception) { Thread.sleep(500) }
            Thread.sleep(interval.toLong())
        }
    }

    // ── 알림 ───────────────────────────────
    private fun createChannels() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "화면 공유 상태", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, "접속 알림", NotificationManager.IMPORTANCE_HIGH))
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        fun act(a: String, code: Int) = PendingIntent.getService(this, code, Intent(this, AgentService::class.java).setAction(a), PendingIntent.FLAG_IMMUTABLE)
        val control = prefs.control && TunnelAccessibilityService.enabled
        val b = Notification.Builder(this, CH_STATUS)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("원격 허용 중 — " + state)
            .setContentText(if (control) "조종도 허용됨 · 언제든 아래 단추로 끌 수 있어요" else "보기만 허용됨")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "중지", act(ACTION_STOP, 1)).build())
        if (control) b.addAction(Notification.Action.Builder(null, "조종 끄기", act(ACTION_PANIC, 2)).build())
        return b.build()
    }

    private fun update() {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, buildNotification())
        try {
            if (viewers > 0) { if (wake == null) wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tt:remote"); if (!wake!!.isHeld) wake!!.acquire(60 * 60 * 1000L) }
            else wake?.takeIf { it.isHeld }?.release()
        } catch (_: Exception) {}
    }

    /** 누군가 보기 시작하면 팝업 알림 (이 폰 주인에게만) */
    private fun alertViewer(n: Int) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(ALERT_ID, Notification.Builder(this, CH_ALERT).setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("누군가 이 폰 화면을 보고 있어요").setContentText("지금 $n 명이 보는 중이에요. 알림의 '중지'로 끌 수 있어요.").setAutoCancel(true).build())
    }

    private fun alertWrongPin() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(ALERT_ID, Notification.Builder(this, CH_ALERT).setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("누군가 틀린 PIN 으로 접속을 시도했어요").setContentText("이 폰의 PIN 을 모르는 사람일 수 있어요.").setAutoCancel(true).build())
    }
}
