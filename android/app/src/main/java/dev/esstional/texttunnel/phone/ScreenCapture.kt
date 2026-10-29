package dev.esstional.texttunnel.phone

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.util.DisplayMetrics
import android.view.WindowManager
import kotlin.math.min

/**
 * MediaProjection(사용자가 허용 창에서 승인) 으로 이 폰 화면을 캡처한다.
 * 한 번 받은 MediaProjection 으로는 VirtualDisplay 를 한 번만 만들 수 있어서(안드로이드 14+), 크기가 바뀌면 만들지 않고 resize 한다.
 * 가상 화면은 화면이 바뀔 때만 새 그림을 주므로, 마지막 그림을 들고 있다가 새 그림이 없으면 그것을 돌려준다.
 */
class ScreenCapture(private val ctx: Context, private val projection: MediaProjection) {
    private val thread = HandlerThread("tt-capture").also { it.start() }
    private val handler = Handler(thread.looper)
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var last: Bitmap? = null
    var width = 0; private set
    var height = 0; private set

    private fun realSize(): IntArray {
        val m = DisplayMetrics()
        @Suppress("DEPRECATION")
        (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
        return intArrayOf(m.widthPixels, m.heightPixels, m.densityDpi)
    }

    /** 가로를 maxWidth 이하로 줄인 크기로 맞춘다. 화면 회전으로 실제 크기가 바뀌어도 이 호출로 따라간다 */
    @Synchronized
    fun configure(maxWidth: Int) {
        val real = realSize()
        val w = min(maxWidth, real[0]) and 1.inv()
        val h = (real[1].toLong() * w / real[0]).toInt() and 1.inv()
        if (display != null && w == width && h == height) return
        val r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        val d = display
        if (d == null) {
            display = projection.createVirtualDisplay("tt-phone", w, h, real[2], DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, handler)
        } else {
            d.resize(w, h, real[2]); d.surface = r.surface
        }
        reader?.close(); reader = r
        width = w; height = h; last = null
    }

    /** 가장 최근 화면 한 장 (새 그림이 없으면 마지막 것). 아직 한 장도 없으면 null */
    @Synchronized
    fun grab(): Bitmap? {
        val img = reader?.acquireLatestImage()
        if (img != null) {
            try {
                val p = img.planes[0]
                val pad = (p.rowStride - p.pixelStride * width) / p.pixelStride
                val raw = Bitmap.createBitmap(width + pad, height, Bitmap.Config.ARGB_8888)
                raw.copyPixelsFromBuffer(p.buffer)
                val bmp = if (pad == 0) raw else Bitmap.createBitmap(raw, 0, 0, width, height).also { raw.recycle() }
                last = bmp
            } finally { img.close() }
        }
        return last
    }

    @Synchronized
    fun release() {
        try { display?.release() } catch (_: Exception) {}
        try { reader?.close() } catch (_: Exception) {}
        display = null; reader = null; last = null
        thread.quitSafely()
    }
}
