using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using System.Reflection;

[assembly: AssemblyTitle("Codex 移动助手 · Windows 10 专用版")]
[assembly: AssemblyProduct("Codex 移动助手 · Windows 10 专用版")]
[assembly: AssemblyCompany("maxlzyver")]
[assembly: AssemblyCopyright("Copyright © maxlzyver")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]

namespace CodexMobile
{
    public sealed class LauncherConfig
    {
        public string codexBinary { get; set; }
        public string defaultCwd { get; set; }
    }

    public sealed class RunningServer
    {
        public int pid { get; set; }
        public int port { get; set; }
        public string root { get; set; }
        public long startedAt { get; set; }
        public string OwnerUrl;
        public string OwnerToken;
    }

    // Public pure policy supports boundary tests without launching UI or changing the OS.
    public static class WindowsPlatformPolicy
    {
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct SystemInfo
        {
            public ushort ProcessorArchitecture;
            public ushort Reserved;
            public uint PageSize;
            public IntPtr MinimumApplicationAddress;
            public IntPtr MaximumApplicationAddress;
            public UIntPtr ActiveProcessorMask;
            public uint NumberOfProcessors;
            public uint ProcessorType;
            public uint AllocationGranularity;
            public ushort ProcessorLevel;
            public ushort ProcessorRevision;
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern void GetNativeSystemInfo(out SystemInfo info);

        public static bool Supports(string editionId, int build, ushort nativeArchitecture)
        {
            // PROCESSOR_ARCHITECTURE_AMD64=9. ARM64=12 must fail even under x64 emulation.
            if (nativeArchitecture != 9) return false;
            if (editionId == "windows10") return build >= 19045 && build < 22000;
            if (editionId == "windows11") return build >= 22000;
            return false;
        }

        public static ushort NativeArchitecture()
        {
            SystemInfo info;
            GetNativeSystemInfo(out info);
            return info.ProcessorArchitecture;
        }

        public static int CurrentBuild()
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
            {
                int build;
                return key != null && Int32.TryParse(Convert.ToString(key.GetValue("CurrentBuildNumber"), CultureInfo.InvariantCulture), out build) ? build : 0;
            }
        }
    }

    internal static class Program
    {
        internal static readonly string Root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
        internal static readonly string Runtime = Path.Combine(Root, ".runtime");
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        internal static readonly object LogLock = new object();
        internal static bool SilentUpdate;
        internal const string EditionId = "windows10";
        internal const string EditionLabel = "Windows 10 专用版";
        internal const string Platform = "Windows 10 x64";
        internal const string Version = "1.2.0";
        internal const string DisplayName = "Codex 移动助手 · Windows 10 专用版";
        internal static readonly long StartedAt = (long)(Process.GetCurrentProcess().StartTime.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;

        [STAThread]
        private static void Main(string[] args)
        {
            SilentUpdate = Array.IndexOf(args, "--after-update") >= 0;
            if (Array.IndexOf(args, "--check") >= 0) { RunCheck(); return; }
            if (Array.IndexOf(args, "--stop") >= 0) { RunStop(); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                if (!SupportedWindows()) throw new InvalidOperationException("此包仅适用于 Windows 10 22H2 x64（系统版本 19045 至 21999）。不支持 ARM 或 32 位系统，请下载与你电脑匹配的专用版。");
                if (!ValidEditionProfile()) throw new InvalidOperationException("edition.json 与此启动器不匹配。请完整解压 Windows 10 专用版，不要混用其他平台的文件。");
                if (!File.Exists(Path.Combine(Root, "server.mjs"))) throw new InvalidOperationException("未找到 server.mjs。请先完整解压压缩包，再运行文件夹中的 Codex-Mobile.exe；不要只复制 EXE。");
                Directory.CreateDirectory(Runtime);
                string mutexName = "Local\\CodexMobile-" + FolderHash(Root);
                bool created;
                using (Mutex mutex = new Mutex(true, mutexName, out created))
                {
                    if (!created)
                    {
                        if (SilentUpdate) return;
                        RunningServer running = Service.TryRead(null, true);
                        if (running != null) OpenBrowser(running.OwnerUrl);
                        else MessageBox.Show("Codex移动助手已在运行或正在启动。请查看任务栏右侧的托盘图标，或完成已打开的设置窗口。", Program.DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                        return;
                    }
                    File.WriteAllText(Path.Combine(Runtime, "launcher-process.json"), Json.Serialize(new { pid = Process.GetCurrentProcess().Id, root = Root, startedAt = StartedAt }), Encoding.UTF8);
                    try { Application.Run(new LauncherContext()); }
                    finally
                    {
                        try { File.Delete(Path.Combine(Runtime, "launcher-process.json")); } catch { }
                        mutex.ReleaseMutex();
                    }
                }
            }
            catch (Exception error) { ShowError(error); }
        }

        internal static bool SupportedWindows()
        {
            return Environment.Is64BitOperatingSystem && WindowsPlatformPolicy.Supports(EditionId, WindowsPlatformPolicy.CurrentBuild(), WindowsPlatformPolicy.NativeArchitecture());
        }

        internal static bool ValidEditionProfile()
        {
            try
            {
                Dictionary<string, object> profile = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Root, "edition.json"), Encoding.UTF8));
                return Convert.ToString(profile["id"]) == EditionId && Convert.ToString(profile["version"]) == Version
                    && Convert.ToString(profile["platform"]) == Platform && Convert.ToString(profile["repository"]) == "maxlzyver/codex-mobile-editions"
                    && Convert.ToString(profile["updatePath"]) == "editions/" + EditionId;
            }
            catch { return false; }
        }

        private static void RunStop()
        {
            try
            {
                RunningServer server = Service.TryRead(null, true);
                if (server != null) Service.Stop(server);
                Environment.ExitCode = 0;
            }
            catch (Exception error) { Log("Normal shutdown failed: " + error.GetType().Name); Environment.ExitCode = 1; }
        }

        internal static string FolderHash(string folder)
        {
            using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(folder).ToLowerInvariant()))).Replace("-", "").Substring(0, 32);
        }

        internal static void ShowError(Exception error)
        {
            if (SilentUpdate) { Log("Background restart failed: " + error.Message); return; }
            MessageBox.Show(error.Message, Program.DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        internal static void OpenBrowser(string url)
        {
            Uri parsed;
            if (!Uri.TryCreate(url, UriKind.Absolute, out parsed) || parsed.Scheme != "http" || parsed.Host != "127.0.0.1" || !parsed.Fragment.StartsWith("#owner=", StringComparison.Ordinal)) throw new InvalidOperationException("管理链接无效。请重新启动控制台。");
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }

        internal static void Log(string line)
        {
            // Never write raw child output, credentials, pairing links, or owner URLs.
            lock (LogLock)
            {
                try { File.AppendAllText(Path.Combine(Runtime, "launcher.log"), DateTimeOffset.Now.ToString("u") + " " + line + Environment.NewLine, Encoding.UTF8); }
                catch { }
            }
        }

        internal static string QuoteArgument(string value)
        {
            // Windows CreateProcess escaping; no command shell is involved.
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
                result.Append('\\', slashes); result.Append(character); slashes = 0;
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }

        private static void RunCheck()
        {
            bool platform = false, files = true, codex = false, profile = false;
            int build = 0;
            ushort architecture = 65535;
            int nodeMajor = 0;
            string failure = null;
            try
            {
                build = WindowsPlatformPolicy.CurrentBuild();
                architecture = WindowsPlatformPolicy.NativeArchitecture();
                platform = Environment.Is64BitOperatingSystem && WindowsPlatformPolicy.Supports(EditionId, build, architecture);
                profile = ValidEditionProfile();
                string[] required = { "server.mjs", @"lib\security.mjs", @"lib\tasks.mjs", @"lib\codex-bridge.mjs", @"lib\tunnel.mjs", @"vendor\qrcode.cjs", @"public\index.html", @"public\app.js", @"public\styles.css", @"public\settings.js", @"public\settings.css", @"public\support-wechat.jpg", "edition.json", @"lib\app-info.mjs" };
                foreach (string file in required) if (!File.Exists(Path.Combine(Root, file))) files = false;
                string binary = Discovery.FindCodex(null);
                codex = binary != null;
                nodeMajor = Discovery.NodeVersion(Discovery.FindNode());
            }
            catch (Exception error) { failure = error.GetType().Name; }
            bool ok = platform && profile && files && codex && nodeMajor >= 24 && failure == null;
            try
            {
                Directory.CreateDirectory(Runtime);
                File.WriteAllText(Path.Combine(Runtime, "check.json"), Json.Serialize(new { ok = ok, version = Version, edition = EditionId, profile = new { ok = profile }, platform = new { ok = platform, target = Platform, build = build, nativeArchitecture = architecture }, node = new { ok = nodeMajor >= 24, major = nodeMajor }, codex = new { ok = codex }, files = new { ok = files }, errorType = failure }), Encoding.UTF8);
            }
            catch { ok = false; }
            Environment.ExitCode = ok ? 0 : 1;
        }

        internal static bool ValidWorkDirectory(string folder)
        {
            if (String.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder)) return false;
            string full = Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar);
            if (String.Equals(full, Path.GetPathRoot(folder).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) return false;
            return !String.Equals(full, Root, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
    }

    internal static class Discovery
    {
        internal static string Executable(string candidate)
        {
            if (String.IsNullOrWhiteSpace(candidate)) return null;
            candidate = Environment.ExpandEnvironmentVariables(candidate.Trim().Trim('"'));
            try { return File.Exists(candidate) && String.Equals(Path.GetExtension(candidate), ".exe", StringComparison.OrdinalIgnoreCase) ? Path.GetFullPath(candidate) : null; }
            catch { return null; }
        }

        private static IEnumerable<string> PathCandidates(string executable)
        {
            string value = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in value.Split(Path.PathSeparator))
            {
                string item = null;
                try { item = Executable(Path.Combine(part.Trim().Trim('"'), executable)); } catch { }
                if (item != null) yield return item;
            }
        }

        private static void FindTree(string folder, string filename, int depth, List<string> result)
        {
            if (depth < 0 || !Directory.Exists(folder)) return;
            try
            {
                string direct = Executable(Path.Combine(folder, filename));
                if (direct != null) result.Add(direct);
                if (depth == 0) return;
                foreach (string child in Directory.GetDirectories(folder))
                {
                    try { if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) continue; }
                    catch { continue; }
                    FindTree(child, filename, depth - 1, result);
                }
            }
            catch (UnauthorizedAccessException) { }
            catch (IOException) { }
        }

        internal static string FindCodex(string saved)
        {
            string explicitPath = Environment.GetEnvironmentVariable("CODEX_BINARY");
            if (!String.IsNullOrWhiteSpace(explicitPath))
            {
                string executable = Executable(explicitPath);
                if (executable == null) throw new InvalidOperationException("环境变量 CODEX_BINARY 已设置，但没有指向有效的 EXE。请修正或移除此环境变量后重试；启动器不会用其他路径覆盖它。");
                return executable;
            }
            string existing = Executable(saved);
            if (existing != null) return existing;
            foreach (string candidate in PathCandidates("codex.exe")) return candidate;
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            List<string> candidates = new List<string>();
            FindTree(Path.Combine(local, @"OpenAI\Codex\bin"), "codex.exe", 5, candidates);
            FindTree(Path.Combine(local, @"Programs\Codex"), "codex.exe", 6, candidates);
            FindTree(Path.Combine(roaming, @"npm\node_modules\@openai\codex"), "codex.exe", 10, candidates);
            FindTree(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @".codex\bin"), "codex.exe", 3, candidates);
            candidates.Sort(delegate(string a, string b) { return File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)); });
            return candidates.Count > 0 ? candidates[0] : null;
        }

        internal static string FindNode()
        {
            List<string> candidates = new List<string>();
            candidates.Add(Path.Combine(Program.Root, @"runtime\node.exe"));
            candidates.AddRange(PathCandidates("node.exe"));
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            candidates.Add(Path.Combine(profile, @".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"));
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            FindTree(Path.Combine(local, @"OpenAI\Codex\runtimes"), "node.exe", 6, candidates);
            foreach (string candidate in candidates)
            {
                string executable = Executable(candidate);
                if (executable != null && NodeVersion(executable) >= 24) return executable;
            }
            throw new InvalidOperationException("没有找到 Node.js 24 或更新版本。请使用包含 runtime\\node.exe 的完整便携包，或安装 Node.js 24 后重试。已安装的旧版本不会被自动使用。");
        }

        internal static int NodeVersion(string executable)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(executable, "--version");
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                using (Process process = Process.Start(info))
                {
                    if (!process.WaitForExit(4000)) { try { process.Kill(); } catch { } return 0; }
                    string output = process.StandardOutput.ReadToEnd().Trim();
                    Match match = Regex.Match(output, @"^v(\d+)\.");
                    int major;
                    return process.ExitCode == 0 && match.Success && Int32.TryParse(match.Groups[1].Value, out major) ? major : 0;
                }
            }
            catch { return 0; }
        }
    }

    internal static class Service
    {
        internal static Dictionary<string, object> Request(string origin, string path, string method, object data, CookieContainer cookies, string csrf)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(origin + path);
            request.Method = method;
            request.Proxy = null;
            request.Timeout = 3500;
            request.ReadWriteTimeout = 3500;
            request.AllowAutoRedirect = false;
            request.CookieContainer = cookies;
            request.Accept = "application/json";
            if (!String.IsNullOrEmpty(csrf)) request.Headers["X-CSRF-Token"] = csrf;
            if (method == "POST")
            {
                byte[] bytes = Encoding.UTF8.GetBytes(Program.Json.Serialize(data));
                request.ContentType = "application/json";
                request.ContentLength = bytes.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            }
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return Program.Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }

        internal static RunningServer TryRead(int? expectedPid, bool authenticate)
        {
            try
            {
                RunningServer state = Program.Json.Deserialize<RunningServer>(File.ReadAllText(Path.Combine(Program.Runtime, "server.json")));
                if (state == null || state.pid < 1 || state.port < 1 || state.port > 65535 || String.IsNullOrWhiteSpace(state.root)) return null;
                if (!String.Equals(Path.GetFullPath(state.root).TrimEnd(Path.DirectorySeparatorChar), Program.Root, StringComparison.OrdinalIgnoreCase)) return null;
                if (expectedPid.HasValue && expectedPid.Value != state.pid) return null;
                using (Process process = Process.GetProcessById(state.pid))
                {
                    if (process.HasExited || !String.Equals(process.ProcessName, "node", StringComparison.OrdinalIgnoreCase)) return null;
                    long processTime = (long)(process.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                    if (Math.Abs(processTime - state.startedAt) > 30000) return null;
                }
                string ownerUrl = File.ReadAllText(Path.Combine(Program.Runtime, "owner-url.txt")).Trim();
                Uri owner;
                if (!Uri.TryCreate(ownerUrl, UriKind.Absolute, out owner) || owner.Scheme != "http" || owner.Host != "127.0.0.1" || owner.Port != state.port || owner.AbsolutePath != "/" || !String.IsNullOrEmpty(owner.Query) || !owner.Fragment.StartsWith("#owner=", StringComparison.Ordinal)) return null;
                string token = Uri.UnescapeDataString(owner.Fragment.Substring(7));
                if (!Regex.IsMatch(token, @"^[A-Za-z0-9_-]{20,256}$")) return null;
                string origin = "http://127.0.0.1:" + state.port.ToString(CultureInfo.InvariantCulture);
                Dictionary<string, object> health = Request(origin, "/health", "GET", null, new CookieContainer(), null);
                object app;
                if (!health.TryGetValue("app", out app) || Convert.ToString(app) != "codex-mobile") return null;
                state.OwnerUrl = ownerUrl;
                state.OwnerToken = token;
                if (authenticate)
                {
                    CookieContainer cookies = new CookieContainer();
                    Request(origin, "/api/owner-login", "POST", new { token = token }, cookies, null);
                    Dictionary<string, object> bootstrap = Request(origin, "/api/bootstrap", "GET", null, cookies, null);
                    object role;
                    if (!bootstrap.TryGetValue("role", out role) || Convert.ToString(role) != "owner") return null;
                }
                return state;
            }
            catch { return null; }
        }

        internal static int ChoosePort()
        {
            string configured = Environment.GetEnvironmentVariable("CODEX_MOBILE_PORT");
            int port;
            if (!String.IsNullOrWhiteSpace(configured))
            {
                if (!Int32.TryParse(configured, out port) || port < 1024 || port > 65535) throw new InvalidOperationException("CODEX_MOBILE_PORT 必须是 1024–65535 之间的端口号。");
                if (!PortFree(port)) throw new InvalidOperationException("指定的 CODEX_MOBILE_PORT 已被占用。启动器不会接管其他程序，请修改该端口号后重试。");
                return port;
            }
            for (port = 43127; port < 43227; port++) if (PortFree(port)) return port;
            throw new InvalidOperationException("没有找到可用的本地端口（43127–43226）。请关闭不用的控制台后重试。");
        }

        private static bool PortFree(int port)
        {
            TcpListener listener = new TcpListener(IPAddress.Any, port);
            try { listener.Server.ExclusiveAddressUse = true; listener.Start(); return true; }
            catch (SocketException) { return false; }
            finally { listener.Stop(); }
        }

        internal static RunningServer Start(string node, LauncherConfig config)
        {
            RunningServer existing = TryRead(null, true);
            if (existing != null) { Program.Log("Reused verified local service."); return existing; }
            int port = ChoosePort();
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = node;
            info.Arguments = Program.QuoteArgument(Path.Combine(Program.Root, "server.mjs"));
            info.WorkingDirectory = Program.Root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables["CODEX_BINARY"] = config.codexBinary;
            info.EnvironmentVariables["CODEX_MOBILE_CWD"] = config.defaultCwd;
            info.EnvironmentVariables["CODEX_MOBILE_PORT"] = port.ToString(CultureInfo.InvariantCulture);
            Process process = new Process();
            process.StartInfo = info;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { /* Drain without retaining secrets. */ };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { /* Codex/plugin stderr can contain credentials. */ };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            int pid = process.Id;
            Program.Log("Started local service process " + pid.ToString(CultureInfo.InvariantCulture) + ".");
            for (int attempt = 0; attempt < 120; attempt++)
            {
                if (process.HasExited) throw new InvalidOperationException("控制台服务启动失败（退出码 " + process.ExitCode.ToString(CultureInfo.InvariantCulture) + "）。请检查完整解压后的文件、工作目录权限和 Node.js 版本。");
                RunningServer ready = TryRead(pid, true);
                if (ready != null) return ready;
                Thread.Sleep(250);
            }
            throw new InvalidOperationException("控制台启动超时。请稍后重新运行启动器；它会安全检查并复用已经启动的服务。");
        }

        internal static void Stop(RunningServer expected)
        {
            RunningServer current = TryRead(expected.pid, false);
            if (current == null)
            {
                try { using (Process process = Process.GetProcessById(expected.pid)) { if (!process.HasExited) throw new InvalidOperationException("无法验证当前服务，已取消退出操作。没有结束任何其他进程。"); } }
                catch (ArgumentException) { return; }
                return;
            }
            if (current.startedAt != expected.startedAt) throw new InvalidOperationException("服务身份已改变，已取消退出操作。请重新打开控制台后再试。");
            string origin = "http://127.0.0.1:" + current.port.ToString(CultureInfo.InvariantCulture);
            CookieContainer cookies = new CookieContainer();
            Request(origin, "/api/owner-login", "POST", new { token = current.OwnerToken }, cookies, null);
            Dictionary<string, object> bootstrap = Request(origin, "/api/bootstrap", "GET", null, cookies, null);
            object role, csrf;
            if (!bootstrap.TryGetValue("role", out role) || Convert.ToString(role) != "owner" || !bootstrap.TryGetValue("csrfToken", out csrf)) throw new InvalidOperationException("无法取得本机管理会话，服务未停止。");
            Request(origin, "/api/shutdown", "POST", new Dictionary<string, object>(), cookies, Convert.ToString(csrf));
            for (int attempt = 0; attempt < 80; attempt++)
            {
                try { using (Process process = Process.GetProcessById(current.pid)) if (process.HasExited) return; }
                catch (ArgumentException) { return; }
                Thread.Sleep(200);
            }
            throw new InvalidOperationException("已发出正常退出请求，但服务尚未结束。请稍后再试；启动器没有强制终止 Codex 或其他程序。");
        }
    }

    internal sealed class LauncherContext : ApplicationContext
    {
        private readonly NotifyIcon tray;
        private readonly Form splash;
        private readonly Control dispatcher;
        private readonly Label status;
        private readonly System.Windows.Forms.Timer updateTimer;
        private bool finished;
        private LauncherConfig config;
        private RunningServer server;
        private bool stopping;

        internal LauncherContext()
        {
            dispatcher = new Control();
            IntPtr ignored = dispatcher.Handle;
            splash = new Form();
            splash.Text = Program.DisplayName;
            splash.ClientSize = new Size(440, 175);
            splash.FormBorderStyle = FormBorderStyle.FixedDialog;
            splash.ControlBox = false;
            splash.StartPosition = FormStartPosition.CenterScreen;
            splash.BackColor = Color.FromArgb(247, 249, 246);
            splash.Font = new Font("Microsoft YaHei UI", 9F);
            Label title = new Label { Text = "Codex移动助手", Location = new Point(26, 22), AutoSize = true, Font = new Font("Microsoft YaHei UI", 17F, FontStyle.Bold), ForeColor = Color.FromArgb(38, 77, 64) };
            status = new Label { Text = Program.EditionLabel + " · 正在准备手机控制台…", Location = new Point(28, 73), Size = new Size(380, 34), ForeColor = Color.FromArgb(96, 113, 94) };
            ProgressBar progress = new ProgressBar { Location = new Point(28, 125), Size = new Size(384, 7), Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 35 };
            splash.Controls.Add(title); splash.Controls.Add(status); splash.Controls.Add(progress);
            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripItem versionItem = menu.Items.Add(Program.DisplayName + " · " + Program.Version + " · maxlzyver");
            versionItem.Enabled = false;
            menu.Items.Add("打开控制台", null, delegate { OpenConsole(); });
            menu.Items.Add("更换默认工作目录", null, delegate { ChangeFolder(); });
            menu.Items.Add("登录 Codex", null, delegate { Login(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出控制台（停止手机任务）", null, delegate { Shutdown(); });
            tray = new NotifyIcon { Text = Program.DisplayName, Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application, ContextMenuStrip = menu, Visible = false };
            tray.DoubleClick += delegate { OpenConsole(); };
            updateTimer = new System.Windows.Forms.Timer();
            updateTimer.Interval = 750;
            updateTimer.Tick += delegate { CheckUpdateExit(); };
            updateTimer.Start();
            splash.Shown += delegate { BeginStartup(); };
            if (Program.SilentUpdate) dispatcher.BeginInvoke((Action)BeginStartup);
            else splash.Show();
        }

        private void CheckUpdateExit()
        {
            if (stopping || finished) return;
            try
            {
                string filename = Path.Combine(Program.Runtime, "update-exit.json");
                if (!File.Exists(filename)) return;
                Dictionary<string, object> request = Program.Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(filename));
                if (Convert.ToInt32(request["pid"]) != Process.GetCurrentProcess().Id || Convert.ToInt64(request["startedAt"]) != Program.StartedAt
                    || !String.Equals(Path.GetFullPath(Convert.ToString(request["root"])), Program.Root, StringComparison.OrdinalIgnoreCase)) return;
                stopping = true;
                Program.Log("Verified update request: releasing the tray launcher for replacement.");
                File.Delete(filename);
                Finish();
            }
            catch { /* A partial or unrelated request never stops this launcher. */ }
        }

        private void BeginStartup()
        {
            try
            {
                try { config = Program.Json.Deserialize<LauncherConfig>(File.ReadAllText(Path.Combine(Program.Runtime, "launcher.json"))); } catch { }
                if (config == null) config = new LauncherConfig();
                config.codexBinary = Discovery.FindCodex(config.codexBinary);
                if (config.codexBinary == null)
                {
                    if (Program.SilentUpdate) throw new InvalidOperationException("后台更新后无法找到 Codex，请从程序目录手动重新启动并配置。");
                    MessageBox.Show(splash, "没有自动找到 Codex。请先安装并登录官方 Codex，然后选择电脑上的 codex.exe。此便携包不包含 Codex 或任何人的登录信息。", "选择 Codex", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    using (OpenFileDialog dialog = new OpenFileDialog())
                    {
                        dialog.Title = "选择 Codex 可执行文件";
                        dialog.Filter = "Codex 程序 (codex.exe)|codex.exe|可执行文件 (*.exe)|*.exe";
                        dialog.CheckFileExists = true;
                        dialog.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                        if (dialog.ShowDialog(splash) != DialogResult.OK) { Finish(); return; }
                        config.codexBinary = Discovery.Executable(dialog.FileName);
                    }
                }
                string configuredCwd = Environment.GetEnvironmentVariable("CODEX_MOBILE_CWD");
                if (!String.IsNullOrWhiteSpace(configuredCwd))
                {
                    if (!Program.ValidWorkDirectory(configuredCwd)) throw new InvalidOperationException("CODEX_MOBILE_CWD 必须指向已存在的项目文件夹，且不能是磁盘根目录或便携程序目录。");
                    config.defaultCwd = Path.GetFullPath(configuredCwd);
                }
                if (!Program.ValidWorkDirectory(config.defaultCwd))
                {
                    if (Program.SilentUpdate) throw new InvalidOperationException("后台更新后默认工作目录不可用，请手动打开启动器重新选择。");
                    string chosen = ChooseFolder(null);
                    if (chosen == null) { Finish(); return; }
                    config.defaultCwd = chosen;
                }
                SaveConfig();
                status.Text = "正在检查运行环境并启动后台服务…";
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try
                    {
                        string node = Discovery.FindNode();
                        RunningServer ready = Service.Start(node, config);
                        dispatcher.BeginInvoke((Action)delegate
                        {
                            server = ready;
                            tray.Visible = true;
                            splash.Hide();
                            if (!Program.SilentUpdate)
                            {
                                try { Program.OpenBrowser(server.OwnerUrl); }
                                catch (Exception error) { Program.ShowError(error); }
                                tray.ShowBalloonTip(4000, Program.DisplayName + "已启动", "手机连接入口已在浏览器打开。右键托盘图标可以打开控制台或安全退出。", ToolTipIcon.Info);
                            }
                        });
                    }
                    catch (Exception error) { dispatcher.BeginInvoke((Action)delegate { Program.ShowError(error); Finish(); }); }
                });
            }
            catch (Exception error) { Program.ShowError(error); Finish(); }
        }

        private string ChooseFolder(string current)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "请选择手机新任务的默认工作目录。请使用你自己的项目文件夹；不要选择磁盘根目录或 Codex移动助手程序文件夹。";
                dialog.ShowNewFolderButton = true;
                dialog.SelectedPath = Directory.Exists(current) ? current : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                while (dialog.ShowDialog(splash.Visible ? splash : null) == DialogResult.OK)
                {
                    if (Program.ValidWorkDirectory(dialog.SelectedPath)) return Path.GetFullPath(dialog.SelectedPath);
                    MessageBox.Show("请选择独立的项目文件夹，不能使用磁盘根目录、此便携程序目录或其子目录。", "选择工作目录", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            return null;
        }

        private void SaveConfig()
        {
            File.WriteAllText(Path.Combine(Program.Runtime, "launcher.json"), Program.Json.Serialize(config), Encoding.UTF8);
        }

        private void OpenConsole()
        {
            if (stopping) return;
            try
            {
                RunningServer current = Service.TryRead(server == null ? (int?)null : server.pid, false);
                if (current == null) throw new InvalidOperationException("后台服务已停止或无法验证。请退出此启动器，然后重新运行 Codex-Mobile.exe。");
                Program.OpenBrowser(current.OwnerUrl);
            }
            catch (Exception error) { Program.ShowError(error); }
        }

        private void ChangeFolder()
        {
            if (stopping) return;
            try
            {
                string chosen = ChooseFolder(config.defaultCwd);
                if (chosen == null) return;
                config.defaultCwd = chosen;
                SaveConfig();
                MessageBox.Show("默认工作目录已保存。退出控制台并重新启动后生效；已有任务仍使用各自原来的目录。", Program.DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception error) { Program.ShowError(error); }
        }

        private void Login()
        {
            if (stopping) return;
            try
            {
                // The login console is deliberately visible because it requires user interaction.
                Process.Start(new ProcessStartInfo { FileName = config.codexBinary, Arguments = "login", WorkingDirectory = config.defaultCwd, UseShellExecute = true, WindowStyle = ProcessWindowStyle.Normal });
            }
            catch (Exception error) { Program.ShowError(error); }
        }

        private void Shutdown()
        {
            if (stopping) return;
            stopping = true;
            tray.Text = "Codex移动助手 · 正在安全退出";
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { if (server != null) Service.Stop(server); dispatcher.BeginInvoke((Action)delegate { Finish(); }); }
                catch (Exception error) { dispatcher.BeginInvoke((Action)delegate { stopping = false; tray.Text = Program.DisplayName; Program.ShowError(error); }); }
            });
        }

        private void Finish()
        {
            if (finished) return;
            finished = true;
            updateTimer.Stop();
            updateTimer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            splash.Dispose();
            ExitThread();
        }
    }
}
