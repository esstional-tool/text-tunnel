package dev.esstional.texttunnel.phone

import org.json.JSONArray

/**
 * 보기 전용 버전(이슈 #50)의 빈 자리. 접근성 서비스를 선언하지 않으므로 이 클래스는 서비스가 아니고 항상 "꺼짐"이다.
 * 조종 포함 버전(src/control)의 같은 이름 클래스와 같은 모양이라 나머지 코드는 어느 쪽이든 그대로 쓴다.
 */
class TunnelAccessibilityService {
    companion object {
        val instance: TunnelAccessibilityService? = null
        val enabled: Boolean get() = false
    }

    fun releaseAll() {}
    fun apply(events: JSONArray) {}
}
