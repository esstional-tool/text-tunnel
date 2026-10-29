package dev.esstional.texttunnel.phone

import android.content.Context
import android.content.SharedPreferences

/**
 * 이 폰에만 저장하는 설정. 백업·클라우드 동기화 대상이 아니다 (allowBackup=false).
 * key 는 메신저와 같은 짝 열쇠(= 원격 입장 자격)라서 이 앱의 전용 저장 공간 밖으로 나가지 않는다.
 */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.applicationContext.getSharedPreferences("tt", Context.MODE_PRIVATE)

    var server: String
        get() = sp.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(v) = sp.edit().putString("server", v.trim().trimEnd('/')).apply()

    var key: String?
        get() = sp.getString("key", null)
        set(v) = sp.edit().putString("key", v).apply()

    var pinSalt: String?
        get() = sp.getString("pinSalt", null)
        set(v) = sp.edit().putString("pinSalt", v).apply()

    var pinHash: String?
        get() = sp.getString("pinHash", null)
        set(v) = sp.edit().putString("pinHash", v).apply()

    /** 조종 허용 (기본 꺼짐 = 보기만 된다). 접근성 서비스를 켜야 실제로 동작한다 */
    var control: Boolean
        get() = sp.getBoolean("control", false)
        set(v) = sp.edit().putBoolean("control", v).apply()

    val paired: Boolean get() = key != null
    val hasPin: Boolean get() = pinHash != null

    companion object {
        const val DEFAULT_SERVER = "https://text-tunnel.onrender.com"
    }
}
