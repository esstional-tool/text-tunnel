// text-tunnel 원격조종 에이전트 (이슈 #17 화면 보기, #21 PIN, #23 마우스·키보드 조종, #24 바뀐 부분만 보내기)
// 조종당하는 PC 에서 도는 작은 프로그램. 메신저와 같은 짝 열쇠를 가진 브라우저가 들어오면 화면을 JPEG 로 보낸다.
//
//   처음 한 번:  remote-agent.exe --code ABC123            (메신저 앱 메뉴 → 새 기기 연결 의 코드)
//   그다음부터:  remote-agent.exe                          (저장된 열쇠로 자동 연결)
//   PIN:         트레이 메뉴 → 접속 PIN 설정…  (또는 --set-pin 123456)   ← PIN 을 정하기 전에는 아무도 볼 수 없다
//   조종:        트레이 메뉴 → 원격 조종 허용 (또는 --allow-control / --deny-control). 기본은 꺼짐 = 보기만 된다
//   즉시 중지:   Ctrl+Alt+F12, 트레이 메뉴, 또는 설정 폴더에 panic.now 파일 만들기
//   옵션:        --server https://…  --config <폴더>  --quiet (접속 알림 토스트·소리 끄기, 띠는 그대로 — 시험용)
//
// 안전장치 (무인 접속이라 필수)
//   · 트레이 아이콘이 항상 떠 있고, 거기서 언제든 OFF / 종료
//   · 누군가 화면을 보는 동안 화면 맨 위에 빨간 "원격 접속 중" 띠가 항상 떠 있음 (끌 수 없음, 1초마다 다시 맨 위로)
//   · 보기 시작하는 순간 토스트 + 소리, 끝나면 토스트 — 이 PC 앞에 있는 사람에게만 (보는 쪽에는 알림 없음)
//   · 보는 사람이 없으면 화면을 찍지도 보내지도 않음
//   · 화면은 64x64 칸으로 나눠 이전 화면과 비교하고, 바뀐 곳만 조각으로 보냄 (바뀐 게 없으면 아무것도 안 보냄). 처음·큰 변화·10초마다·서버 요청 시에는 전체 화면(키 프레임)
//   · 같은 짝 열쇠를 가진 기기가 **이 PC 의 주인이 정한 PIN** 까지 맞춰야 볼 수 있음 (PIN 은 이 PC 에만 해시로 저장, 5번 틀리면 10분 잠금)
//   · 조종(마우스·키보드)은 보기와 별개: 이 PC 의 주인이 "원격 조종 허용"을 켜야 하고(기본 꺼짐), 보는 사람이 또 "조종 켜기"를 눌러야 함.
//     조종 중에는 띠가 "원격 조종 중"으로 바뀜. 즉시 중지: 전역 단축키 Ctrl+Alt+F12 또는 트레이 "조종 즉시 중지" → 조종 허용이 꺼지고 눌려 있던 키·버튼도 모두 뗌
//   · 접속 성공·실패·잠금은 이 PC 의 access.log 에 기록 (PIN·열쇠·화면은 기록하지 않음), 틀린 시도는 토스트로 알림
//
// 빌드: build-agent.cmd (Windows 내장 csc.exe, C# 5 — 문자열 보간·?. 같은 새 문법은 못 씀)
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Native
{
    // 화면 배율(DPI)이 150% 같은 PC 에서도 실제 픽셀 크기로 찍으려면 필요하다
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int memcmp(IntPtr a, IntPtr b, UIntPtr count);
    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")] public static extern void CopyMemory(IntPtr dst, IntPtr src, UIntPtr count);
}

static class Json
{
    static readonly JavaScriptSerializer J = new JavaScriptSerializer();
    public static string Write(object o) { return J.Serialize(o); }
    public static Dictionary<string, object> Read(string s) { return J.DeserializeObject(s) as Dictionary<string, object>; }
}

// 서버와의 통신 (HttpWebRequest: 이 컴파일러 환경에서 SSE 스트림을 읽기 가장 단순함)
class Server
{
    readonly string baseUrl;
    public Server(string baseUrl) { this.baseUrl = baseUrl.TrimEnd('/'); }

    HttpWebRequest Req(string path, string method, int timeoutMs)
    {
        HttpWebRequest r = (HttpWebRequest)WebRequest.Create(baseUrl + path);
        r.Method = method; r.Timeout = timeoutMs; r.ReadWriteTimeout = timeoutMs; r.KeepAlive = true;
        r.UserAgent = "text-tunnel-agent/1";
        return r;
    }

    public Dictionary<string, object> PostJson(string path, object body)
    {
        byte[] data = Encoding.UTF8.GetBytes(Json.Write(body));
        HttpWebRequest r = Req(path, "POST", 15000);
        r.ContentType = "application/json"; r.ContentLength = data.Length;
        using (Stream s = r.GetRequestStream()) s.Write(data, 0, data.Length);
        using (HttpWebResponse resp = (HttpWebResponse)r.GetResponse())
        using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            return Json.Read(sr.ReadToEnd());
    }

    // 키 프레임(이미지 한 장) 또는 조각 묶음을 올린다. 서버의 답: "ok" | "key"(다음에 키 프레임을 보내 줘) | "idle"(보는 사람이 없음) | null(실패)
    public string PostFrame(string token, byte[] body, int w, int h, bool patch)
    {
        HttpWebRequest r = Req("/api/remote/frame?token=" + Uri.EscapeDataString(token) + "&w=" + w + "&h=" + h + (patch ? "&kind=patch" : ""), "POST", 10000);
        r.ContentType = patch ? "application/x-tt-patch" : "image/jpeg"; r.ContentLength = body.Length;
        using (Stream s = r.GetRequestStream()) s.Write(body, 0, body.Length);
        using (HttpWebResponse resp = (HttpWebResponse)r.GetResponse())
        using (StreamReader sr = new StreamReader(resp.GetResponseStream())) return sr.ReadToEnd();
    }

    public void Leave(string token)
    {
        try
        {
            HttpWebRequest r = Req("/api/remote/leave?token=" + Uri.EscapeDataString(token), "POST", 3000);
            r.ContentLength = 0; using (r.GetRequestStream()) { }
            r.GetResponse().Close();
        }
        catch (Exception) { }
    }

    // SSE: "data: {...}" 줄이 올 때마다 handler 를 부른다. 연결이 끊기거나 Abort 되면 끝난다
    public HttpWebRequest OpenEvents(string token)
    {
        HttpWebRequest r = Req("/api/remote/agent/events?token=" + Uri.EscapeDataString(token), "GET", 100000);
        r.ReadWriteTimeout = 60000; // 서버가 25초마다 ping 을 보내므로 60초 조용하면 끊긴 것
        return r;
    }
    public static void ReadEvents(HttpWebRequest r, Action<Dictionary<string, object>> handler)
    {
        using (HttpWebResponse resp = (HttpWebResponse)r.GetResponse())
        using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
        {
            string line;
            while ((line = sr.ReadLine()) != null)
                if (line.StartsWith("data: ")) handler(Json.Read(line.Substring(6)));
        }
    }
}

// 화면 찍기 + JPEG 만들기
static class Capture
{
    static readonly ImageCodecInfo JpegCodec = FindJpeg();
    static ImageCodecInfo FindJpeg()
    {
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") return c;
        throw new InvalidOperationException("JPEG 인코더가 없어요");
    }

    // 시험용: --fake-screen <폴더> 이면 이 PC 의 실제 화면 대신, 폴더의 fake-screen.txt 로 그린 합성 화면을 쓴다 (실제 화면 내용을 읽지 않고 바뀐 영역을 정확히 조절하려고)
    //   형식:  size 1280 720  /  rect x y w h r g b  (줄마다. 기본 바탕은 가로 띠 무늬)
    public static string FakeDir;

    // 주 모니터를 찍어 가로 maxWidth 이하로 줄인 24비트 비트맵을 돌려준다 (부른 쪽이 Dispose)
    public static Bitmap Snap(int maxWidth, out int w, out int h)
    {
        if (FakeDir != null) return Fake(out w, out h);
        Rectangle b = Screen.PrimaryScreen.Bounds;
        double scale = b.Width > maxWidth ? (double)maxWidth / b.Width : 1.0;
        w = (int)(b.Width * scale); h = (int)(b.Height * scale);
        using (Bitmap full = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb))
        {
            using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(b.Location, Point.Empty, b.Size);
            if (scale >= 1.0) return (Bitmap)full.Clone();
            Bitmap small = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            using (Graphics g2 = Graphics.FromImage(small)) { g2.InterpolationMode = InterpolationMode.Bilinear; g2.DrawImage(full, 0, 0, w, h); }
            return small;
        }
    }

    static Bitmap Fake(out int w, out int h)
    {
        w = 1280; h = 720;
        List<int[]> rects = new List<int[]>();
        try
        {
            foreach (string line in File.ReadAllLines(Path.Combine(FakeDir, "fake-screen.txt")))
            {
                string[] p = line.Trim().Split(' ');
                if (p[0] == "size" && p.Length >= 3) { w = Convert.ToInt32(p[1]); h = Convert.ToInt32(p[2]); }
                else if (p[0] == "rect" && p.Length >= 8) { int[] r = new int[7]; for (int i = 0; i < 7; i++) r[i] = Convert.ToInt32(p[i + 1]); rects.Add(r); }
            }
        }
        catch (Exception) { }
        Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.FromArgb(28, 30, 54));
            for (int y = 0; y < h; y += 80) using (SolidBrush br = new SolidBrush(Color.FromArgb(40, 44, 80))) g.FillRectangle(br, 0, y, w, 40);
            foreach (int[] r in rects) using (SolidBrush br = new SolidBrush(Color.FromArgb(r[4], r[5], r[6]))) g.FillRectangle(br, r[0], r[1], r[2], r[3]);
        }
        return bmp;
    }

    // 비트맵의 한 영역을 JPEG 로 인코딩
    public static byte[] EncodeJpeg(Bitmap src, Rectangle r, long quality)
    {
        using (Bitmap part = (r.Width == src.Width && r.Height == src.Height) ? (Bitmap)src.Clone() : src.Clone(r, PixelFormat.Format24bppRgb))
        using (MemoryStream ms = new MemoryStream())
        using (EncoderParameters ep = new EncoderParameters(1))
        {
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            part.Save(ms, JpegCodec, ep);
            return ms.ToArray();
        }
    }
}

// 이전에 보낸 화면과 비교해 바뀐 칸을 찾는다 (이슈 #24). 이전 화면은 이 프로그램 메모리(비관리 버퍼)에만 둔다.
// 칸 단위(64x64)로 memcmp 비교 → 같은 줄의 연속 칸을 한 사각형으로, 위아래로 같은 가로 범위면 합침
class Differ
{
    public const int Tile = 64;
    IntPtr prev = IntPtr.Zero; int pw, ph, pstride;
    public bool Has { get { return prev != IntPtr.Zero; } }
    public int Width { get { return pw; } }
    public int Height { get { return ph; } }

    public void Reset() { if (prev != IntPtr.Zero) { Marshal.FreeHGlobal(prev); prev = IntPtr.Zero; } }

    // 지금 화면을 "이전 화면" 으로 저장한다
    public void Store(Bitmap bmp)
    {
        BitmapData d = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            if (prev == IntPtr.Zero || pw != bmp.Width || ph != bmp.Height || pstride != d.Stride)
            {
                Reset(); pw = bmp.Width; ph = bmp.Height; pstride = d.Stride; prev = Marshal.AllocHGlobal(pstride * ph);
            }
            Native.CopyMemory(prev, d.Scan0, (UIntPtr)(uint)(pstride * ph));
        }
        finally { bmp.UnlockBits(d); }
    }

    // 이전 화면과 비교해 바뀐 사각형 목록을 돌려주고, 지금 화면을 이전 화면으로 갱신한다. 크기가 다르면 null (키 프레임을 보내야 함)
    public List<Rectangle> Diff(Bitmap bmp, out long changedPixels)
    {
        changedPixels = 0;
        if (prev == IntPtr.Zero || bmp.Width != pw || bmp.Height != ph) return null;
        List<Rectangle> rects = new List<Rectangle>();
        BitmapData d = bmp.LockBits(new Rectangle(0, 0, pw, ph), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            if (d.Stride != pstride) return null;
            int tx = (pw + Tile - 1) / Tile, ty = (ph + Tile - 1) / Tile;
            for (int j = 0; j < ty; j++)
            {
                int y0 = j * Tile, th = Math.Min(Tile, ph - y0);
                int runStart = -1;
                for (int i = 0; i <= tx; i++)
                {
                    bool changed = false;
                    if (i < tx)
                    {
                        int x0 = i * Tile, tw = Math.Min(Tile, pw - x0);
                        for (int r = 0; r < th && !changed; r++)
                        {
                            int off = (y0 + r) * pstride + x0 * 3;
                            changed = Native.memcmp((IntPtr)(d.Scan0.ToInt64() + off), (IntPtr)(prev.ToInt64() + off), (UIntPtr)(uint)(tw * 3)) != 0;
                        }
                    }
                    if (changed && runStart < 0) runStart = i;
                    if (!changed && runStart >= 0)
                    {
                        int x0 = runStart * Tile, x1 = Math.Min(pw, i * Tile);
                        rects.Add(new Rectangle(x0, y0, x1 - x0, th));
                        runStart = -1;
                    }
                }
            }
            // 위아래로 가로 범위가 같고 맞닿아 있으면 하나로 합침
            for (int a = 0; a < rects.Count; a++)
                for (int b = a + 1; b < rects.Count; b++)
                    if (rects[b].X == rects[a].X && rects[b].Width == rects[a].Width && rects[b].Y == rects[a].Bottom)
                    {
                        rects[a] = new Rectangle(rects[a].X, rects[a].Y, rects[a].Width, rects[a].Height + rects[b].Height);
                        rects.RemoveAt(b); b = a; // 합쳐졌으니 처음부터 다시 찾는다
                    }
            foreach (Rectangle r in rects) changedPixels += (long)r.Width * r.Height;
            if (rects.Count > 0) Native.CopyMemory(prev, d.Scan0, (UIntPtr)(uint)(pstride * ph));
        }
        finally { bmp.UnlockBits(d); }
        return rects;
    }
}

// 마우스·키보드 입력을 이 PC 에 넣는다 (이슈 #23). 좌표는 화면 비율(0~1) → 주 모니터 실제 픽셀
// 누르고 있는 키·버튼을 기억해 두었다가, 조종이 꺼지면 모두 뗀다 (키가 눌린 채로 남는 사고 방지)
static class Inject
{
    static readonly object Gate = new object();
    // 시험용: --input-sink <파일> 이면 실제로 입력을 넣지 않고 "무슨 입력을 넣었을 것인지"만 파일에 적는다 (화면이 잠긴 PC·자동 시험에서 전체 경로를 확인하려고)
    public static string Sink;
    static bool enabled = false; // 조종이 허용·켜진 동안만 true. ReleaseAll 이 같은 잠금 안에서 false 로 만들어, 끄는 순간과 입력 적용이 엇갈려도 키가 남지 않는다
    public static void Enable() { lock (Gate) enabled = true; }
    static void Rec(string s) { File.AppendAllText(Sink, s + "\n"); }
    static void Cur(int x, int y) { if (Sink != null) Rec("move " + x + " " + y); else Native.SetCursorPos(x, y); }
    static void Mouse(uint flags, int data) { if (Sink != null) Rec("mouse " + flags + " " + data); else Native.mouse_event(flags, 0, 0, data, UIntPtr.Zero); }
    static void Key(int vk, uint flags) { if (Sink != null) Rec("key " + vk + " " + flags); else Native.keybd_event((byte)vk, (byte)Native.MapVirtualKey((uint)vk, 0), flags, UIntPtr.Zero); }
    static readonly Dictionary<int, bool> keysDown = new Dictionary<int, bool>(); // 키 -> 확장 키 여부 (뗄 때 같은 플래그가 필요)
    static readonly HashSet<int> buttonsDown = new HashSet<int>();
    static readonly uint[] Down = { 0x0002, 0x0008, 0x0020 }, Up = { 0x0004, 0x0010, 0x0040 }; // 왼쪽·오른쪽·가운데
    static int BtnIndex(int b) { return b == 0 ? 0 : (b == 2 ? 1 : 2); } // 브라우저 버튼 번호: 0 왼쪽, 1 가운데, 2 오른쪽

    static double D(object o) { return Convert.ToDouble(o); }
    static void MoveTo(object xo, object yo)
    {
        Rectangle b = Screen.PrimaryScreen.Bounds;
        int x = b.X + (int)Math.Round(Math.Max(0, Math.Min(1, D(xo))) * (b.Width - 1));
        int y = b.Y + (int)Math.Round(Math.Max(0, Math.Min(1, D(yo))) * (b.Height - 1));
        Cur(x, y);
    }

    public static void Apply(object[] events)
    {
        if (events == null) return;
        lock (Gate)
            for (int i = 0; enabled && i < events.Length && i < 200; i++)
            {
                Dictionary<string, object> e = events[i] as Dictionary<string, object>;
                if (e == null || !e.ContainsKey("t")) continue;
                try { One(e); } catch (Exception) { }
            }
    }
    static void One(Dictionary<string, object> e)
    {
        string t = (string)e["t"];
        if (t == "m") MoveTo(e["x"], e["y"]);
        else if (t == "d" || t == "u")
        {
            MoveTo(e["x"], e["y"]);
            int bi = BtnIndex(Convert.ToInt32(e["b"]));
            if (t == "d") { buttonsDown.Add(bi); Mouse(Down[bi], 0); }
            else { buttonsDown.Remove(bi); Mouse(Up[bi], 0); }
        }
        else if (t == "w")
        {
            int dy = Convert.ToInt32(e["dy"]), dx = Convert.ToInt32(e["dx"]);
            if (dy != 0) Mouse(0x0800, Math.Max(-1200, Math.Min(1200, -dy * 120 / 100)));
            if (dx != 0) Mouse(0x1000, Math.Max(-1200, Math.Min(1200, dx * 120 / 100)));
        }
        else if (t == "k")
        {
            int vk = Convert.ToInt32(e["vk"]); if (vk < 1 || vk > 254) return;
            bool down = Convert.ToInt32(e["d"]) != 0, ext = Convert.ToInt32(e["e"]) != 0;
            if (down) keysDown[vk] = ext; else keysDown.Remove(vk);
            Key(vk, (ext ? 1u : 0u) | (down ? 0u : 2u));
        }
        else if (t == "r") ReleaseAll();
    }

    public static void ReleaseAll()
    {
        lock (Gate)
        {
            foreach (KeyValuePair<int, bool> kv in new List<KeyValuePair<int, bool>>(keysDown)) Key(kv.Key, 2u | (kv.Value ? 1u : 0u));
            foreach (int bi in new List<int>(buttonsDown)) Mouse(Up[bi], 0);
            keysDown.Clear(); buttonsDown.Clear(); enabled = false;
        }
    }
}

// PIN 은 이 PC 의 주인이 정한다. 해시(PBKDF2 + 무작위 솔트)로만 이 PC 에 저장하고, 서버로는 절대 보내지 않는다.
// 서버가 전달해 준 "보는 사람이 입력한 PIN" 을 에이전트가 여기서 직접 맞는지 확인한다.
static class PinStore
{
    const int Iterations = 100000;
    static string PinFile(string dir) { return Path.Combine(dir, "pin.dat"); }
    public static bool Valid(string pin) { return pin != null && System.Text.RegularExpressions.Regex.IsMatch(pin, "^[0-9]{6,12}$"); }
    public static bool Exists(string dir) { return File.Exists(PinFile(dir)); }

    static byte[] Hash(string pin, byte[] salt)
    {
        Rfc2898DeriveBytes d = new Rfc2898DeriveBytes(pin, salt, Iterations);
        return d.GetBytes(32);
    }
    public static void Set(string dir, string pin)
    {
        byte[] salt = new byte[16];
        using (System.Security.Cryptography.RandomNumberGenerator rng = System.Security.Cryptography.RandomNumberGenerator.Create()) rng.GetBytes(salt);
        File.WriteAllText(PinFile(dir), Convert.ToBase64String(salt) + ":" + Convert.ToBase64String(Hash(pin, salt)), Encoding.ASCII);
    }
    public static bool Check(string dir, string pin)
    {
        if (!Valid(pin) || !Exists(dir)) return false;
        string[] parts = File.ReadAllText(PinFile(dir), Encoding.ASCII).Trim().Split(':');
        byte[] want = Convert.FromBase64String(parts[1]);
        byte[] got = Hash(pin, Convert.FromBase64String(parts[0]));
        int diff = 0; // 시간이 일정하게 걸리도록 끝까지 비교한다
        for (int i = 0; i < want.Length && i < got.Length; i++) diff |= want[i] ^ got[i];
        return diff == 0 && want.Length == got.Length;
    }
}

// 접속 기록: 이 PC 에만 남는 감사용 파일. 시각과 결과만 — PIN·열쇠·화면은 절대 기록하지 않는다
static class AccessLog
{
    static readonly object Gate = new object();
    public static string Dir;
    public static void Write(string text)
    {
        try
        {
            lock (Gate) File.AppendAllText(Path.Combine(Dir, "access.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine, Encoding.UTF8);
        }
        catch (Exception) { }
    }
}

// PIN 설정 창 (트레이 메뉴에서)
class PinDialog : Form
{
    readonly TextBox a = new TextBox(), b = new TextBox();
    readonly Label msg = new Label();
    public string Pin;
    public PinDialog()
    {
        Text = "접속 PIN 설정"; FormBorderStyle = FormBorderStyle.FixedDialog; StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false; MinimizeBox = false; ClientSize = new Size(340, 190); TopMost = true;
        Label l1 = new Label { Text = "다른 PC 가 이 화면을 보려면 입력해야 하는 숫자예요 (6~12자리).", Left = 14, Top = 12, Width = 312, Height = 34 };
        Label l2 = new Label { Text = "PIN", Left = 14, Top = 56, Width = 80 };
        Label l3 = new Label { Text = "PIN 한 번 더", Left = 14, Top = 86, Width = 80 };
        a.Left = 100; a.Top = 52; a.Width = 226; a.UseSystemPasswordChar = true; a.MaxLength = 12;
        b.Left = 100; b.Top = 82; b.Width = 226; b.UseSystemPasswordChar = true; b.MaxLength = 12;
        msg.Left = 14; msg.Top = 116; msg.Width = 312; msg.Height = 20; msg.ForeColor = Color.FromArgb(200, 30, 30);
        Button ok = new Button { Text = "저장", Left = 170, Top = 148, Width = 76 };
        Button cancel = new Button { Text = "취소", Left = 250, Top = 148, Width = 76, DialogResult = DialogResult.Cancel };
        ok.Click += delegate
        {
            if (!PinStore.Valid(a.Text)) { msg.Text = "6~12자리 숫자로 정해 주세요."; return; }
            if (a.Text != b.Text) { msg.Text = "두 번 입력한 PIN 이 달라요."; return; }
            Pin = a.Text; DialogResult = DialogResult.OK;
        };
        AcceptButton = ok; CancelButton = cancel;
        Controls.AddRange(new Control[] { l1, l2, l3, a, b, msg, ok, cancel });
    }
}

// 누군가 보는 동안 화면 맨 위에 항상 떠 있는 빨간 띠
class Banner : Form
{
    readonly Label label = new Label();
    public Banner()
    {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
        Rectangle b = Screen.PrimaryScreen.Bounds;
        Bounds = new Rectangle(b.X, b.Y, b.Width, 26);
        BackColor = Color.FromArgb(200, 30, 30);
        Text = "text-tunnel-remote-banner";
        label.Dock = DockStyle.Fill; label.ForeColor = Color.White; label.TextAlign = ContentAlignment.MiddleCenter;
        label.Font = new Font("Malgun Gothic", 9.5f, FontStyle.Bold);
        Controls.Add(label);
    }
    protected override bool ShowWithoutActivation { get { return true; } } // 쓰던 창의 포커스를 빼앗지 않음
    protected override CreateParams CreateParams
    {
        get { CreateParams p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000080; return p; } // NOACTIVATE | TOOLWINDOW
    }
    // 다른 최상위 창(발표·동영상 등)이 덮어도 다시 맨 위로 올린다. 포커스는 빼앗지 않음.
    // HWND_TOPMOST(-1), SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW
    public void KeepOnTop()
    {
        if (Visible && IsHandleCreated) Native.SetWindowPos(Handle, (IntPtr)(-1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010 | 0x0040);
    }
    public void SetCount(int n, int controllers)
    {
        if (controllers > 0)
        {
            BackColor = Color.FromArgb(170, 20, 90);
            label.Text = "● 원격 조종 중 (" + n + "명이 보고, " + controllers + "명이 조종) — 즉시 중지: Ctrl+Alt+F12 또는 트레이 아이콘";
        }
        else
        {
            BackColor = Color.FromArgb(200, 30, 30);
            label.Text = "● 원격 접속 중 (" + n + "명이 이 화면을 보고 있어요) — 트레이 아이콘에서 끌 수 있어요";
        }
    }

    // 전역 단축키 Ctrl+Alt+F12 = "조종 즉시 중지" (이슈 #23). 어느 창이 앞에 있든 동작
    public event Action PanicKey;
    const int HotkeyId = 0x7C01;
    public bool HotkeyOk;
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        HotkeyOk = Native.RegisterHotKey(Handle, HotkeyId, 0x0002 | 0x0001 | 0x4000, 0x7B); // CTRL | ALT | NOREPEAT, F12
    }
    protected override void OnHandleDestroyed(EventArgs e) { Native.UnregisterHotKey(Handle, HotkeyId); base.OnHandleDestroyed(e); }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312 && (int)m.WParam == HotkeyId) { Action a = PanicKey; if (a != null) a(); return; }
        base.WndProc(ref m);
    }
}

// 트레이 아이콘 + 전체 흐름
class AgentContext : ApplicationContext
{
    readonly Server server; readonly string key; readonly string name; readonly bool quiet; readonly string dir;
    const int MaxFails = 5; static readonly TimeSpan LockFor = TimeSpan.FromMinutes(10);
    int pinFails = 0; DateTime lockedUntil = DateTime.MinValue; // 메모리에만 — 에이전트를 껐다 켜면 초기화
    int lastViewers = 0, lastControllers = 0; // 알림용: 보는 사람 수가 달라진 순간을 알아채려고
    readonly NotifyIcon tray = new NotifyIcon();
    readonly Banner banner = new Banner();
    readonly ToolStripMenuItem toggle = new ToolStripMenuItem();
    readonly ToolStripMenuItem info = new ToolStripMenuItem();
    readonly ToolStripMenuItem fpsInfo = new ToolStripMenuItem();
    volatile bool on = true, quit = false;
    volatile int viewers = 0, controllers = 0;
    volatile bool allowControl = false;
    readonly HashSet<string> authedVids = new HashSet<string>(); // 이 에이전트가 PIN 을 직접 확인해 통과시킨 보는 사람들 (입력은 이들만)
    readonly ToolStripMenuItem controlItem = new ToolStripMenuItem();
    volatile string token;
    volatile bool controlReported = false;
    readonly object controlPostGate = new object();
    volatile HttpWebRequest events;
    volatile int framesSent, lastKb;

    public AgentContext(Server server, string key, string name, bool quiet, string dir)
    {
        this.server = server; this.key = key; this.name = name; this.quiet = quiet; this.dir = dir;
        banner.Visible = false; banner.Opacity = 1;
        IntPtr unused = banner.Handle; // 핸들을 미리 만들어 둔다 (다른 스레드에서 BeginInvoke 하려고)

        info.Enabled = false; fpsInfo.Enabled = false;
        toggle.Click += delegate { SetOn(!on); };
        ToolStripMenuItem pinItem = new ToolStripMenuItem("접속 PIN 설정…");
        pinItem.Click += delegate { SetPinFromMenu(); };
        controlItem.Click += delegate { SetControl(!allowControl, "트레이 메뉴"); };
        ToolStripMenuItem panic = new ToolStripMenuItem("조종 즉시 중지 (Ctrl+Alt+F12)");
        panic.Click += delegate { Panic("트레이 메뉴"); };
        banner.PanicKey += delegate { Panic("단축키 Ctrl+Alt+F12"); };
        ToolStripMenuItem exit = new ToolStripMenuItem("종료");
        exit.Click += delegate { Quit(); };
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[] { info, fpsInfo, new ToolStripSeparator(), pinItem, controlItem, panic, toggle, exit });
        tray.ContextMenuStrip = menu; tray.Icon = SystemIcons.Shield; tray.Visible = true;
        tray.DoubleClick += delegate { SetOn(!on); };
        allowControl = File.Exists(ControlFile(dir));
        Refresh();
        if (!banner.HotkeyOk) AccessLog.Write("경고: 즉시 중지 단축키(Ctrl+Alt+F12)를 등록하지 못했어요 (다른 프로그램이 사용 중) — 트레이 메뉴로 끌 수 있어요");
        if (!quiet)
        {
            if (PinStore.Exists(dir)) tray.ShowBalloonTip(3000, "text-tunnel 원격", "켜졌어요. 트레이 아이콘에서 끌 수 있어요.", ToolTipIcon.Info);
            else tray.ShowBalloonTip(6000, "접속 PIN 을 정해 주세요", "PIN 을 정하기 전에는 아무도 이 화면을 볼 수 없어요. 트레이 아이콘 메뉴 → 접속 PIN 설정", ToolTipIcon.Warning);
        }

        new Thread(ConnectLoop) { IsBackground = true }.Start();
        new Thread(CaptureLoop) { IsBackground = true }.Start();
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer { Interval = 1000 };
        t.Tick += delegate { Refresh(); }; t.Start();
    }

    public static string ControlFile(string dir) { return Path.Combine(dir, "control.on"); }

    // 조종 허용 켜기/끄기. 끄면 눌려 있던 키·버튼을 모두 떼고 서버(보는 사람들)에게도 즉시 알린다
    public void SetControl(bool value, string why)
    {
        if (allowControl == value) return;
        allowControl = value;
        try { if (value) File.WriteAllText(ControlFile(dir), "on"); else if (File.Exists(ControlFile(dir))) File.Delete(ControlFile(dir)); } catch (Exception) { }
        if (!value) Inject.ReleaseAll();
        AccessLog.Write(value ? "조종 허용을 켰어요 (" + why + ")" : "조종 허용을 껐어요 (" + why + ")");
        ReportControl();
        UI(new Action(Refresh));
    }
    void Panic(string why)
    {
        Inject.ReleaseAll();
        AccessLog.Write("조종 즉시 중지 (" + why + ")");
        if (allowControl) SetControl(false, why);
        else ReportControl();
        if (!quiet) UI(new Action(delegate { tray.ShowBalloonTip(3000, "조종을 중지했어요", "다시 허용하려면 트레이 메뉴 → 원격 조종 허용", ToolTipIcon.Info); }));
    }
    void ReportControl()
    {
        string t = token; if (t == null) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            lock (controlPostGate) // 순서가 뒤바뀌지 않게 한 번에 하나씩, 실패하면 몇 번 다시 시도 (최신 상태만 보낸다)
                for (int i = 0; i < 4; i++)
                {
                    try { server.PostJson("/api/remote/agent/control?token=" + Uri.EscapeDataString(t), new Dictionary<string, object> { { "allowed", allowControl } }); break; }
                    catch (Exception) { Thread.Sleep(400); }
                }
        });
    }

    // "panic.now" 파일이 생기면 조종을 즉시 끈다 (스크립트·원격 셸에서 echo > panic.now). 끄는 방향 전용이라 안전하다
    string PanicFile { get { return Path.Combine(dir, "panic.now"); } }

    void Refresh()
    {
        if (File.Exists(PanicFile)) { try { File.Delete(PanicFile); } catch (Exception) { } Panic("panic.now 파일"); }
        controlItem.Text = "원격 조종 허용 (마우스·키보드)"; controlItem.Checked = allowControl;
        toggle.Text = on ? "원격 허용 끄기 (OFF)" : "원격 허용 켜기 (ON)";
        info.Text = !on ? "꺼짐 — 아무도 볼 수 없어요"
            : (!PinStore.Exists(dir) ? "PIN 을 정해야 볼 수 있어요"
            : (DateTime.UtcNow < lockedUntil ? "PIN 을 너무 많이 틀려 잠겨 있어요"
            : (viewers > 0 ? "보는 중: " + viewers + "명" : "켜짐 — 대기 중")));
        fpsInfo.Text = framesSent > 0 ? "보낸 것: 전체 " + keysSent + " · 조각 " + patchesSent + " (마지막 " + lastKb + "KB)" : "아직 보낸 화면 없음";
        tray.Text = "text-tunnel 원격: " + (!on ? "꺼짐" : (viewers > 0 ? "보는 중 " + viewers + "명" : "대기 중"));
        bool show = on && viewers > 0;
        if (show != banner.Visible) { if (show) banner.Show(); else banner.Hide(); }
        if (show) { banner.SetCount(viewers, allowControl ? controllers : 0); banner.KeepOnTop(); } // 1초마다 불리므로 덮여도 곧 복구
        Alert(on ? viewers : 0);
    }

    // 이 PC 앞에 있는 사람에게만 알린다 (보는 쪽에는 아무 알림도 없음).
    // 보기 시작하는 순간: 토스트 + 소리, 끝나는 순간: 토스트.  --quiet 이면 알림·소리를 끄고 띠만 유지한다 (시험용)
    void Alert(int now)
    {
        int cNow = (on && allowControl) ? controllers : 0;
        if (cNow > 0 && lastControllers == 0) AccessLog.Write("조종 시작 (" + cNow + "명)");
        else if (cNow == 0 && lastControllers > 0) { Inject.ReleaseAll(); AccessLog.Write("조종 끝"); }
        lastControllers = cNow;
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

    // PIN 설정 (트레이 메뉴)
    void SetPinFromMenu()
    {
        using (PinDialog d = new PinDialog())
            if (d.ShowDialog() == DialogResult.OK)
            {
                PinStore.Set(dir, d.Pin); pinFails = 0; lockedUntil = DateTime.MinValue;
                AccessLog.Write("PIN 을 새로 정했어요");
                if (!quiet) tray.ShowBalloonTip(3000, "접속 PIN 을 저장했어요", "이제 이 PIN 을 아는 사람만 이 화면을 볼 수 있어요.", ToolTipIcon.Info);
                Refresh();
            }
    }

    // 서버가 전달한 "보는 사람이 입력한 PIN" 을 여기서 직접 확인한다 (서버는 PIN 을 저장하지 않고 판정만 중계).
    // 5번 틀리면 10분 동안 스스로 잠근다 — 잠긴 동안은 맞는 PIN 도 거절
    void HandleAuth(string vid, string pin)
    {
        string t = token; if (t == null) return;
        Dictionary<string, object> reply = new Dictionary<string, object>();
        reply["vid"] = vid;
        bool good = false;
        if (!PinStore.Exists(dir))
        {
            reply["ok"] = false; reply["code"] = "no-pin";
            AccessLog.Write("접속 거절: PIN 을 아직 정하지 않았어요");
        }
        else if (DateTime.UtcNow < lockedUntil)
        {
            reply["ok"] = false; reply["code"] = "locked"; reply["locked"] = true; reply["lockedUntil"] = EpochMs(lockedUntil);
            AccessLog.Write("접속 거절: 잠금 중 (맞는 PIN 이어도 거절)");
        }
        else if (PinStore.Check(dir, pin))
        {
            good = true; pinFails = 0; reply["ok"] = true;
            lock (authedVids) authedVids.Add(vid);
            AccessLog.Write("접속 성공");
        }
        else
        {
            pinFails++;
            reply["ok"] = false; reply["code"] = "wrong"; reply["left"] = Math.Max(0, MaxFails - pinFails);
            if (pinFails >= MaxFails)
            {
                lockedUntil = DateTime.UtcNow + LockFor; pinFails = 0;
                reply["code"] = "locked"; reply["locked"] = true; reply["lockedUntil"] = EpochMs(lockedUntil); reply["left"] = 0;
                AccessLog.Write("접속 실패: PIN 을 " + MaxFails + "번 틀려 " + (int)LockFor.TotalMinutes + "분간 잠금");
            }
            else AccessLog.Write("접속 실패: PIN 이 틀렸어요 (남은 횟수 " + (MaxFails - pinFails) + ")");
            if (!quiet) UI(new Action(delegate { tray.ShowBalloonTip(5000, "누군가 틀린 PIN 으로 접속을 시도했어요", "이 PC 의 PIN 을 모르는 사람일 수 있어요.", ToolTipIcon.Warning); }));
        }
        try { server.PostJson("/api/remote/agent/auth?token=" + Uri.EscapeDataString(t), reply); }
        catch (Exception) { }
        if (good) UI(new Action(Refresh));
    }
    static long EpochMs(DateTime utc) { return (long)(utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

    void UI(Action a) { if (!banner.IsDisposed && banner.IsHandleCreated) banner.BeginInvoke(a); }

    void SetOn(bool value)
    {
        if (on == value) return;
        on = value;
        if (!on) Disconnect();
        UI(new Action(Refresh));
    }

    void Disconnect()
    {
        string t = token; token = null; viewers = 0; controllers = 0; Inject.ReleaseAll();
        HttpWebRequest r = events; if (r != null) { try { r.Abort(); } catch (Exception) { } }
        if (t != null) server.Leave(t);
    }

    void Quit()
    {
        quit = true; Disconnect(); tray.Visible = false; tray.Dispose(); banner.Dispose(); ExitThread();
    }

    // 서버에 입장해 "보는 사람 수" 알림을 계속 받는다. 끊기면 2초 뒤 다시 (서버 재시작·네트워크 끊김 대비)
    void ConnectLoop()
    {
        while (!quit)
        {
            if (!on) { Thread.Sleep(300); continue; }
            try
            {
                Dictionary<string, object> j = server.PostJson("/api/remote/agent/join", new Dictionary<string, object> { { "key", key }, { "name", name } });
                token = (string)j["token"]; controlReported = false; lock (authedVids) authedVids.Clear();
                HttpWebRequest r = server.OpenEvents(token); events = r;
                Server.ReadEvents(r, delegate (Dictionary<string, object> ev)
                {
                    if (ev == null || !ev.ContainsKey("type")) return;
                    string type = ev["type"] as string;
                    if (type == "viewers")
                    {
                        viewers = Convert.ToInt32(ev["count"]);
                        int newCtl = ev.ContainsKey("controllers") ? Convert.ToInt32(ev["controllers"]) : 0;
                        if (newCtl < controllers) Inject.ReleaseAll(); // 한 명이라도 조종을 끄면 눌려 있던 것을 바로 뗀다 (다음 입력이 오면 다시 누르게 됨)
                        controllers = newCtl;
                        if (allowControl && newCtl > 0) Inject.Enable();
                        UI(new Action(Refresh));
                        if (!controlReported) { controlReported = true; ReportControl(); } // 연결 직후 한 번: 이 PC 의 조종 허용 상태를 알림
                    }
                    else if (type == "input")
                    {
                        // 조종이 허용되어 있고, 이 에이전트가 PIN 을 확인해 준 보는 사람의 입력만 넣는다 (서버를 믿지 않고 여기서도 확인)
                        string ivid = ev.ContainsKey("vid") ? ev["vid"] as string : null; bool known = false; if (ivid == null) return; lock (authedVids) known = authedVids.Contains(ivid);
                        if (on && allowControl && known && controllers > 0) Inject.Apply(ev["ev"] as object[]);
                    }
                    else if (type == "auth")
                    {
                        string vid = (string)ev["vid"], pin = (string)ev["pin"];
                        ThreadPool.QueueUserWorkItem(delegate { HandleAuth(vid, pin); }); // PBKDF2 는 느리므로 알림 수신을 막지 않게 따로
                    }
                });
            }
            catch (Exception) { }
            viewers = 0; controllers = 0; token = null; Inject.ReleaseAll(); lock (authedVids) authedVids.Clear(); UI(new Action(Refresh));
            for (int i = 0; i < 20 && !quit && on; i++) Thread.Sleep(100);
        }
    }

    // 보는 사람이 있을 때만 화면을 찍는다. 이전에 보낸 화면과 비교해 바뀐 조각만 보낸다 (이슈 #24).
    // 키 프레임(전체 화면)을 보내는 경우: 처음 · 보는 사람이 없다가 생김 · 화면 크기 변화 · 바뀐 면적이 큼 · 10초마다 · 서버가 요청('key') · 전송 실패
    // 한 장을 다 보낸 뒤에 다음 장을 찍는다 → 네트워크가 느리면 저절로 프레임이 줄어든다
    void CaptureLoop()
    {
        const int intervalMs = 200;   // 목표 초당 5번 확인
        const int keyEveryMs = 10000; // 오래 조각만 쌓이지 않게 가끔 전체 화면
        Differ differ = new Differ();
        bool needKey = true; DateTime lastKey = DateTime.MinValue;
        while (!quit)
        {
            string t = token;
            if (!on || viewers == 0 || t == null) { differ.Reset(); needKey = true; Thread.Sleep(150); continue; }
            DateTime start = DateTime.UtcNow;
            try
            {
                int w, h;
                using (Bitmap bmp = Capture.Snap(1280, out w, out h))
                {
                    List<Rectangle> rects = null; long changed = 0;
                    if (!needKey && (DateTime.UtcNow - lastKey).TotalMilliseconds < keyEveryMs)
                    {
                        rects = differ.Diff(bmp, out changed);
                        if (rects == null) needKey = true;                      // 화면 크기가 바뀜
                        else if (rects.Count == 0) rects = null;                 // 바뀐 게 없음 → 아무것도 보내지 않음
                        else if (changed * 100 > (long)w * h * KeyAreaPercent) needKey = true; // 대부분이 바뀜 → 전체 화면이 더 쌈
                        else if (rects.Count > 12) rects = new List<Rectangle>(new Rectangle[] { Union(rects) }); // 조각이 너무 많으면 큰 사각형 하나로
                    }
                    else needKey = true;

                    string answer = null; int sent = 0;
                    if (needKey)
                    {
                        byte[] jpeg = Capture.EncodeJpeg(bmp, new Rectangle(0, 0, w, h), 60);
                        answer = server.PostFrame(t, jpeg, w, h, false); sent = jpeg.Length;
                        if (answer != null) { differ.Store(bmp); lastKey = DateTime.UtcNow; needKey = false; keysSent++; }
                    }
                    else if (rects != null)
                    {
                        byte[] bundle = Bundle(bmp, rects);
                        answer = server.PostFrame(t, bundle, w, h, true); sent = bundle.Length;
                        if (answer != null) patchesSent++;
                    }
                    if (answer == null && (needKey || rects != null)) needKey = true; // 보내지 못했으면 다음에 전체 화면으로 다시 맞춘다
                    if (answer == "key" || answer == "idle") needKey = true;
                    if (answer == "ok" || answer == "key") { framesSent++; lastKb = Math.Max(1, sent / 1024); }
                }
            }
            catch (Exception) { needKey = true; Thread.Sleep(500); }
            int wait = intervalMs - (int)(DateTime.UtcNow - start).TotalMilliseconds;
            if (wait > 0) Thread.Sleep(wait);
        }
    }

    const int KeyAreaPercent = 60; // 바뀐 면적이 화면의 이 비율 이상이면 키 프레임
    volatile int keysSent, patchesSent;

    static Rectangle Union(List<Rectangle> rs)
    {
        Rectangle u = rs[0];
        for (int i = 1; i < rs.Count; i++) u = Rectangle.Union(u, rs[i]);
        return u;
    }

    // 조각 묶음: u8 개수 | 개수 × { u16 x, y, w, h, u32 길이, 이미지 } (큰 값부터)
    static byte[] Bundle(Bitmap bmp, List<Rectangle> rects)
    {
        using (MemoryStream ms = new MemoryStream())
        {
            ms.WriteByte((byte)rects.Count);
            foreach (Rectangle r in rects)
            {
                byte[] img = Capture.EncodeJpeg(bmp, r, 60);
                U16(ms, r.X); U16(ms, r.Y); U16(ms, r.Width); U16(ms, r.Height);
                ms.WriteByte((byte)(img.Length >> 24)); ms.WriteByte((byte)(img.Length >> 16)); ms.WriteByte((byte)(img.Length >> 8)); ms.WriteByte((byte)img.Length);
                ms.Write(img, 0, img.Length);
            }
            return ms.ToArray();
        }
    }
    static void U16(Stream s, int v) { s.WriteByte((byte)(v >> 8)); s.WriteByte((byte)v); }
}

static class Program
{
    static string Arg(string[] a, string name)
    {
        for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
        return null;
    }

    [STAThread]
    static int Main(string[] args)
    {
        Native.SetProcessDPIAware();
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 (Render 는 https)
        ServicePointManager.Expect100Continue = false;
        ServicePointManager.DefaultConnectionLimit = 8;
        Application.EnableVisualStyles();

        string serverUrl = Arg(args, "--server") ?? "https://text-tunnel.onrender.com";
        string dir = Arg(args, "--config") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "text-tunnel-agent");
        Directory.CreateDirectory(dir);
        string keyFile = Path.Combine(dir, "key.txt");
        Server server = new Server(serverUrl);

        string code = Arg(args, "--code");
        if (code != null)
        {
            try
            {
                Dictionary<string, object> j = server.PostJson("/api/pair/claim", new Dictionary<string, object> { { "code", code } });
                File.WriteAllText(keyFile, (string)j["key"], Encoding.ASCII);
            }
            catch (Exception e)
            {
                MessageBox.Show("연결 코드로 짝을 맺지 못했어요.\n코드는 5분 동안 한 번만 쓸 수 있어요. 메신저 앱 메뉴 → 새 기기 연결 에서 새 코드를 받아 주세요.\n\n" + e.Message, "text-tunnel 원격", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 1;
            }
        }
        if (!File.Exists(keyFile))
        {
            MessageBox.Show("아직 연결되지 않았어요.\n메신저 앱 메뉴 → 새 기기 연결 에서 코드를 받아 이렇게 실행하세요:\n\nremote-agent.exe --code ABC123", "text-tunnel 원격", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
        string key = File.ReadAllText(keyFile, Encoding.ASCII).Trim();
        bool quiet = Array.IndexOf(args, "--quiet") >= 0;
        AccessLog.Dir = dir;
        if (Array.IndexOf(args, "--allow-control") >= 0) { File.WriteAllText(AgentContext.ControlFile(dir), "on"); AccessLog.Write("조종 허용을 켰어요 (--allow-control)"); }
        if (Array.IndexOf(args, "--deny-control") >= 0) { if (File.Exists(AgentContext.ControlFile(dir))) File.Delete(AgentContext.ControlFile(dir)); AccessLog.Write("조종 허용을 껐어요 (--deny-control)"); }
        Inject.Sink = Arg(args, "--input-sink"); // 시험용
        Capture.FakeDir = Arg(args, "--fake-screen"); // 시험용: 실제 화면 대신 합성 화면 (폴더의 fake-screen.txt)
        string setPin = Arg(args, "--set-pin");
        if (setPin != null)
        {
            if (!PinStore.Valid(setPin)) { MessageBox.Show("PIN 은 6~12자리 숫자여야 해요.", "text-tunnel 원격", MessageBoxButtons.OK, MessageBoxIcon.Warning); return 2; }
            PinStore.Set(dir, setPin);
            AccessLog.Write("PIN 을 새로 정했어요 (--set-pin)");
        }
        Application.Run(new AgentContext(server, key, Environment.MachineName, quiet, dir));
        return 0;
    }
}
