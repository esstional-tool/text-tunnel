// text-tunnel 원격조종 에이전트 (이슈 #17, 1단계: 화면 보기)
// 조종당하는 PC 에서 도는 작은 프로그램. 메신저와 같은 짝 열쇠를 가진 브라우저가 들어오면 화면을 JPEG 로 보낸다.
//
//   처음 한 번:  remote-agent.exe --code ABC123            (메신저 앱 메뉴 → 새 기기 연결 의 코드)
//   그다음부터:  remote-agent.exe                          (저장된 열쇠로 자동 연결)
//   옵션:        --server https://…  --config <폴더>  --quiet (접속 알림 토스트·소리 끄기, 띠는 그대로 — 시험용)
//
// 안전장치 (무인 접속이라 필수)
//   · 트레이 아이콘이 항상 떠 있고, 거기서 언제든 OFF / 종료
//   · 누군가 화면을 보는 동안 화면 맨 위에 빨간 "원격 접속 중" 띠가 항상 떠 있음 (끌 수 없음, 1초마다 다시 맨 위로)
//   · 보기 시작하는 순간 토스트 + 소리, 끝나면 토스트 — 이 PC 앞에 있는 사람에게만 (보는 쪽에는 알림 없음)
//   · 보는 사람이 없으면 화면을 찍지도 보내지도 않음
//   · 같은 짝 열쇠를 가진 기기만 볼 수 있음
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
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Native
{
    // 화면 배율(DPI)이 150% 같은 PC 에서도 실제 픽셀 크기로 찍으려면 필요하다
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
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

    public bool PostFrame(string token, byte[] jpeg, int w, int h)
    {
        HttpWebRequest r = Req("/api/remote/frame?token=" + Uri.EscapeDataString(token) + "&w=" + w + "&h=" + h, "POST", 10000);
        r.ContentType = "image/jpeg"; r.ContentLength = jpeg.Length;
        using (Stream s = r.GetRequestStream()) s.Write(jpeg, 0, jpeg.Length);
        using (HttpWebResponse resp = (HttpWebResponse)r.GetResponse())
        using (StreamReader sr = new StreamReader(resp.GetResponseStream())) return sr.ReadToEnd() == "ok";
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

    // 주 모니터를 찍어 가로 maxWidth 이하로 줄이고 JPEG(quality) 로 인코딩한다
    public static byte[] Grab(int maxWidth, long quality, out int w, out int h)
    {
        Rectangle b = Screen.PrimaryScreen.Bounds;
        using (Bitmap full = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb))
        {
            using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(b.Location, Point.Empty, b.Size);
            double scale = b.Width > maxWidth ? (double)maxWidth / b.Width : 1.0;
            w = (int)(b.Width * scale); h = (int)(b.Height * scale);
            Bitmap src = full;
            Bitmap small = null;
            try
            {
                if (scale < 1.0)
                {
                    small = new Bitmap(w, h, PixelFormat.Format24bppRgb);
                    using (Graphics g2 = Graphics.FromImage(small)) { g2.InterpolationMode = InterpolationMode.Bilinear; g2.DrawImage(full, 0, 0, w, h); }
                    src = small;
                }
                using (MemoryStream ms = new MemoryStream())
                using (EncoderParameters ep = new EncoderParameters(1))
                {
                    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                    src.Save(ms, JpegCodec, ep);
                    return ms.ToArray();
                }
            }
            finally { if (small != null) small.Dispose(); }
        }
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
    public void SetCount(int n)
    {
        label.Text = "● 원격 접속 중 (" + n + "명이 이 화면을 보고 있어요) — 트레이 아이콘에서 끌 수 있어요";
    }
}

// 트레이 아이콘 + 전체 흐름
class AgentContext : ApplicationContext
{
    readonly Server server; readonly string key; readonly string name; readonly bool quiet;
    int lastViewers = 0; // 알림용: 보는 사람 수가 달라진 순간을 알아채려고
    readonly NotifyIcon tray = new NotifyIcon();
    readonly Banner banner = new Banner();
    readonly ToolStripMenuItem toggle = new ToolStripMenuItem();
    readonly ToolStripMenuItem info = new ToolStripMenuItem();
    readonly ToolStripMenuItem fpsInfo = new ToolStripMenuItem();
    volatile bool on = true, quit = false;
    volatile int viewers = 0;
    volatile string token;
    volatile HttpWebRequest events;
    volatile int framesSent, lastKb;

    public AgentContext(Server server, string key, string name, bool quiet)
    {
        this.server = server; this.key = key; this.name = name; this.quiet = quiet;
        banner.Visible = false; banner.Opacity = 1;
        IntPtr unused = banner.Handle; // 핸들을 미리 만들어 둔다 (다른 스레드에서 BeginInvoke 하려고)

        info.Enabled = false; fpsInfo.Enabled = false;
        toggle.Click += delegate { SetOn(!on); };
        ToolStripMenuItem exit = new ToolStripMenuItem("종료");
        exit.Click += delegate { Quit(); };
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[] { info, fpsInfo, new ToolStripSeparator(), toggle, exit });
        tray.ContextMenuStrip = menu; tray.Icon = SystemIcons.Shield; tray.Visible = true;
        tray.DoubleClick += delegate { SetOn(!on); };
        Refresh();
        tray.ShowBalloonTip(3000, "text-tunnel 원격", "켜졌어요. 트레이 아이콘에서 끌 수 있어요.", ToolTipIcon.Info);

        new Thread(ConnectLoop) { IsBackground = true }.Start();
        new Thread(CaptureLoop) { IsBackground = true }.Start();
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer { Interval = 1000 };
        t.Tick += delegate { Refresh(); }; t.Start();
    }

    void Refresh()
    {
        toggle.Text = on ? "원격 허용 끄기 (OFF)" : "원격 허용 켜기 (ON)";
        info.Text = !on ? "꺼짐 — 아무도 볼 수 없어요" : (viewers > 0 ? "보는 중: " + viewers + "명" : "켜짐 — 대기 중");
        fpsInfo.Text = framesSent > 0 ? "보낸 화면 " + framesSent + "장 (마지막 " + lastKb + "KB)" : "아직 보낸 화면 없음";
        tray.Text = "text-tunnel 원격: " + (!on ? "꺼짐" : (viewers > 0 ? "보는 중 " + viewers + "명" : "대기 중"));
        bool show = on && viewers > 0;
        if (show != banner.Visible) { if (show) banner.Show(); else banner.Hide(); }
        if (show) { banner.SetCount(viewers); banner.KeepOnTop(); } // 1초마다 불리므로 덮여도 곧 복구
        Alert(on ? viewers : 0);
    }

    // 이 PC 앞에 있는 사람에게만 알린다 (보는 쪽에는 아무 알림도 없음).
    // 보기 시작하는 순간: 토스트 + 소리, 끝나는 순간: 토스트.  --quiet 이면 알림·소리를 끄고 띠만 유지한다 (시험용)
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
        string t = token; token = null; viewers = 0;
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
                token = (string)j["token"];
                HttpWebRequest r = server.OpenEvents(token); events = r;
                Server.ReadEvents(r, delegate (Dictionary<string, object> ev)
                {
                    if (ev != null && (string)ev["type"] == "viewers") { viewers = Convert.ToInt32(ev["count"]); UI(new Action(Refresh)); }
                });
            }
            catch (Exception) { }
            viewers = 0; token = null; UI(new Action(Refresh));
            for (int i = 0; i < 20 && !quit && on; i++) Thread.Sleep(100);
        }
    }

    // 보는 사람이 있을 때만 화면을 찍어 보낸다. 한 장을 다 보낸 뒤에 다음 장을 찍는다 → 네트워크가 느리면 저절로 프레임이 줄어든다
    void CaptureLoop()
    {
        const int intervalMs = 200; // 목표 초당 5장
        while (!quit)
        {
            string t = token;
            if (!on || viewers == 0 || t == null) { Thread.Sleep(150); continue; }
            DateTime start = DateTime.UtcNow;
            try
            {
                int w, h;
                byte[] jpeg = Capture.Grab(1280, 60, out w, out h);
                if (server.PostFrame(t, jpeg, w, h)) { framesSent++; lastKb = jpeg.Length / 1024; }
            }
            catch (Exception) { Thread.Sleep(500); }
            int wait = intervalMs - (int)(DateTime.UtcNow - start).TotalMilliseconds;
            if (wait > 0) Thread.Sleep(wait);
        }
    }
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
        Application.Run(new AgentContext(server, key, Environment.MachineName, quiet));
        return 0;
    }
}
