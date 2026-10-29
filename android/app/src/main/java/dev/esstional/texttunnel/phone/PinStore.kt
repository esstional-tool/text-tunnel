package dev.esstional.texttunnel.phone

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * 접속 PIN: 이 폰의 주인이 정하고 이 폰이 직접 확인한다 (PC 에이전트와 같은 원칙).
 * 해시(PBKDF2 + 무작위 솔트)로만 저장하고 서버로는 보내지 않는다. 서버가 전달해 준 "보는 사람이 입력한 PIN" 을 여기서 비교한다.
 */
object PinStore {
    private const val ITERATIONS = 100_000
    private val REGEX = Regex("^[0-9]{6,12}$")

    fun valid(pin: String?): Boolean = pin != null && REGEX.matches(pin)

    fun set(prefs: Prefs, pin: String) {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        prefs.pinSalt = hex(salt)
        prefs.pinHash = hex(hash(pin, salt))
    }

    fun check(prefs: Prefs, pin: String): Boolean {
        val salt = prefs.pinSalt?.let { unhex(it) } ?: return false
        val want = prefs.pinHash?.let { unhex(it) } ?: return false
        return MessageDigest.isEqual(hash(pin, salt), want) // 같은 길이를 끝까지 비교 (시간 차이로 알아내지 못하게)
    }

    private fun hash(pin: String, salt: ByteArray): ByteArray =
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1").generateSecret(PBEKeySpec(pin.toCharArray(), salt, ITERATIONS, 160)).encoded

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
