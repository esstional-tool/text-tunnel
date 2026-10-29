package dev.esstional.texttunnel.phone

import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** 서버와의 통신. 외부 라이브러리 없이 HttpURLConnection 만 쓴다 (서버·PC 에이전트와 같은 프로토콜: SSE + POST) */
class Http(base: String) {
    private val base = base.trimEnd('/')

    class Result(val code: Int, val body: String) {
        val ok get() = code in 200..299
        fun json(): JSONObject? = try { JSONObject(body) } catch (_: Exception) { null }
    }

    private fun open(path: String, method: String, timeoutMs: Int): HttpURLConnection {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.useCaches = false
        c.setRequestProperty("User-Agent", "text-tunnel-phone/1")
        return c
    }

    private fun read(c: HttpURLConnection): Result {
        val code = c.responseCode
        val stream = if (code in 200..299) c.inputStream else c.errorStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        return Result(code, text)
    }

    /** JSON 을 올린다. 4xx/5xx 도 예외 없이 Result 로 돌려준다 (네트워크 오류만 IOException) */
    fun postJson(path: String, body: JSONObject, timeoutMs: Int = 15000): Result {
        val c = open(path, "POST", timeoutMs)
        val data = body.toString().toByteArray(Charsets.UTF_8)
        c.doOutput = true
        c.setFixedLengthStreamingMode(data.size)
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(data) }
        return try { read(c) } finally { c.disconnect() }
    }

    /** 화면 한 장(키 프레임)을 올린다. 서버의 답: "ok" | "key" | "idle" (+ " slow") */
    fun postFrame(token: String, bytes: ByteArray, w: Int, h: Int, mime: String = "image/jpeg"): Result {
        val c = open("/api/remote/frame?token=${enc(token)}&w=$w&h=$h", "POST", 12000)
        c.doOutput = true
        c.setFixedLengthStreamingMode(bytes.size)
        c.setRequestProperty("Content-Type", mime)
        c.outputStream.use { it.write(bytes) }
        return try { read(c) } finally { c.disconnect() }
    }

    fun leave(token: String) {
        try {
            val c = open("/api/remote/leave?token=${enc(token)}", "POST", 3000)
            c.doOutput = true; c.setFixedLengthStreamingMode(0); c.outputStream.close()
            c.responseCode; c.disconnect()
        } catch (_: Exception) {}
    }

    /** SSE 연결을 연다. 줄 단위로 읽으려면 [readEvents] */
    fun openEvents(token: String): HttpURLConnection {
        val c = open("/api/remote/agent/events?token=${enc(token)}", "GET", 100_000)
        c.readTimeout = 60_000 // 서버가 25초마다 ping 을 보내므로 60초 조용하면 끊긴 것
        return c
    }

    /** "data: {...}" 줄이 올 때마다 handler 를 부른다. 연결이 끊기거나 disconnect 되면 끝난다 */
    @Throws(IOException::class)
    fun readEvents(c: HttpURLConnection, handler: (JSONObject) -> Unit) {
        if (c.responseCode != 200) throw IOException("events ${c.responseCode}")
        BufferedReader(InputStreamReader(c.inputStream, Charsets.UTF_8)).use { r ->
            while (true) {
                val line = r.readLine() ?: break
                if (line.startsWith("data: ")) {
                    try { handler(JSONObject(line.substring(6))) } catch (_: org.json.JSONException) {}
                }
            }
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
