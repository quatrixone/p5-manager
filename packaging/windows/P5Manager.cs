// P5Manager.exe - launcher of the portable Windows build.
//
// Starts the bundled Node backend (and the Remote Play service when it is
// part of the package), waits until the web UI answers and opens it in the
// default browser. Both children live in a job object, so closing this
// window - or killing the launcher any other way - stops them too.
//
// Layout it expects next to itself:
//   app\backend\src\index.js      backend (serves the UI from app\backend\dist)
//   app\builtin\                  built-in scripts
//   app\pyremoteplay\server.py    Remote Play service (optional)
//   runtime\p5rp\p5rp.exe         its session helper (AGPL, rpnative\)
//   runtime\node\node.exe
//   runtime\python\python.exe     (optional)
//   runtime\7zip\7z.exe           (optional) extracts archives for the backend
//   data\                         created on first start: database, payloads, downloads
//
// app\ and runtime\ are thousands of small files, which Windows Explorer
// takes minutes to extract from a zip. The download therefore holds them as
// one file, P5Manager.pak (a zip itself), and the launcher unpacks it on the
// first start - see Unpack.
//
// Built with the .NET Framework C# 5 compiler that ships with Windows, so
// no newer language features here.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class P5Manager
{
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static IntPtr job = IntPtr.Zero;

    static void CreateKillOnCloseJob()
    {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr mem = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, mem, false);
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, mem, (uint)size);
        }
        finally { Marshal.FreeHGlobal(mem); }
    }

    // Everything the children print is shown in this window and kept in
    // <data>\app\logs\console.log, which the app offers as part of its log
    // download: what a user sends along when something does not work.
    // The file is held to 2 MB: when it is full it becomes console.1.log,
    // replacing the one before it, and a new one starts - also in the middle
    // of a long run. The two together never take more than 4 MB.
    const long ConsoleLogMax = 2 * 1024 * 1024;
    static StreamWriter consoleLog = null;
    static string consoleLogDir = null;
    static long consoleLogSize = 0;
    static readonly object consoleLock = new object();

    static void OpenConsoleLogFile()
    {
        string file = Path.Combine(consoleLogDir, "console.log");
        if (File.Exists(file) && new FileInfo(file).Length >= ConsoleLogMax)
        {
            string old = Path.Combine(consoleLogDir, "console.1.log");
            File.Delete(old);
            File.Move(file, old);
        }
        consoleLogSize = File.Exists(file) ? new FileInfo(file).Length : 0;
        consoleLog = new StreamWriter(new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false));
    }

    static void OpenConsoleLog(string appData)
    {
        try
        {
            consoleLogDir = Path.Combine(appData, "logs");
            Directory.CreateDirectory(consoleLogDir);
            OpenConsoleLogFile();
            consoleLog.WriteLine("---- " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " P5 Manager started");
            consoleLog.Flush();
        }
        catch { consoleLog = null; }
    }

    static void Emit(string line)
    {
        if (line == null) return;
        lock (consoleLock)
        {
            Console.WriteLine(line);
            if (consoleLog == null) return;
            try
            {
                consoleLog.WriteLine(line);
                consoleLog.Flush();
                consoleLogSize += Encoding.UTF8.GetByteCount(line) + 2;
                if (consoleLogSize >= ConsoleLogMax)
                {
                    consoleLog.Dispose();
                    consoleLog = null;
                    OpenConsoleLogFile();
                }
            }
            catch { }
        }
    }

    static Process Start(string exe, string args, string workDir, string[][] env)
    {
        ProcessStartInfo psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false;
        psi.WorkingDirectory = workDir;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        foreach (string[] kv in env) psi.EnvironmentVariables[kv[0]] = kv[1];
        Process p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Emit(e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Emit(e.Data); };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        if (job != IntPtr.Zero) AssignProcessToJobObject(job, p.Handle);
        return p;
    }

    static bool Answers(string url)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 2000;
            req.Proxy = null;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static string Env(string name, string fallback)
    {
        string v = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrEmpty(v) ? fallback : v;
    }

    static string ReadTrimmed(string file)
    {
        try { return File.ReadAllText(file).Trim(); }
        catch { return ""; }
    }

    // An in-app update (backend\src\routes\update.js) can bring a newer
    // Remote Play service along with the app, in <data>\app\app-update\current.
    // It is used only when it was built against the same Python packages as
    // this package (the "pydeps" fingerprint); otherwise the packaged one runs.
    static string PickSidecarDir(string packaged, string appData)
    {
        string current = Path.Combine(appData, "app-update", "current");
        string updated = Path.Combine(current, "pyremoteplay");
        string want = ReadTrimmed(Path.Combine(packaged, "pydeps"));
        if (want == "" || !File.Exists(Path.Combine(updated, "server.py"))) return packaged;
        Match m = Regex.Match(ReadTrimmed(Path.Combine(current, "manifest.json")), "\"pydeps\"\\s*:\\s*\"([0-9a-f]+)\"");
        return m.Success && m.Groups[1].Value == want ? updated : packaged;
    }

    static Process StartSidecar(string python, string packaged, string appData, string sidecarPort)
    {
        string dir = PickSidecarDir(packaged, appData);
        // The bundled Python only looks where its ._pth file says, which is the
        // packaged folder. For an updated copy, put its own folder first.
        string args = dir == packaged
            ? "server.py"
            : "-c \"import os, runpy, sys; sys.path.insert(0, sys.argv[1]); runpy.run_path(os.path.join(sys.argv[1], 'server.py'), run_name='__main__')\" \"" + dir + "\"";
        Emit("[launcher] starting Remote Play service on 127.0.0.1:" + sidecarPort
            + (dir == packaged ? "" : " (updated copy)"));
        // p5rp, the session helper, is part of the runtime, not of the app:
        // an updated copy of the service finds it here too.
        string p5rp = Path.GetFullPath(Path.Combine(packaged, "..", "..", "runtime", "p5rp", "p5rp.exe"));
        return Start(python, args, dir, new string[][] {
            new string[] { "P5RP_BIN", p5rp },
            new string[] { "PYREMOTEPLAY_SIDECAR_HOST", "127.0.0.1" },
            new string[] { "PYREMOTEPLAY_SIDECAR_PORT", sidecarPort },
            new string[] { "PYTHONUNBUFFERED", "1" },
            new string[] { "PYTHONIOENCODING", "utf-8" },
        });
    }

    // First start: turns P5Manager.pak into app\ and runtime\. The pak is
    // deleted only once everything is out, so a start that was interrupted
    // half way begins again; a pak extracted over an older installation
    // replaces its app\ and runtime\ and leaves data\ alone.
    static bool Unpack(string home)
    {
        string pak = Path.Combine(home, "P5Manager.pak");
        if (!File.Exists(pak)) return true;
        Emit("[launcher] first start: unpacking the app files, this takes a moment...");
        Stopwatch watch = Stopwatch.StartNew();
        try
        {
            foreach (string d in new string[] { "app", "runtime" })
            {
                string old = Path.Combine(home, d);
                if (Directory.Exists(old)) Directory.Delete(old, true);
            }
            string root = home + "\\";
            using (ZipArchive zip = ZipFile.OpenRead(pak))
            {
                int done = 0, shown = 0, total = zip.Entries.Count;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string dest = Path.GetFullPath(Path.Combine(home, entry.FullName));
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("unexpected path in P5Manager.pak: " + entry.FullName);
                    if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                    {
                        Directory.CreateDirectory(dest);
                    }
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        entry.ExtractToFile(dest, true);
                    }
                    int percent = ++done * 100 / total;
                    if (percent >= shown + 20)
                    {
                        shown = percent - percent % 20;
                        Emit("[launcher]   " + shown + " %");
                    }
                }
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("P5 Manager: could not unpack P5Manager.pak: " + e.Message);
            if (e is PathTooLongException)
                Console.Error.WriteLine("The folder is too deep for Windows. Move the P5Manager folder somewhere short, for example C:\\P5Manager.");
            else
                Console.Error.WriteLine("Check that the disk has about 400 MB free and that the folder can be written to, then start again.");
            return false;
        }
        try { File.Delete(pak); }
        catch (Exception e) { Emit("[launcher] could not remove P5Manager.pak (" + e.Message + ") - it will be unpacked again next time"); }
        Emit("[launcher] unpacked in " + (watch.ElapsedMilliseconds / 1000) + " s");
        return true;
    }

    static int Main(string[] args)
    {
        bool openBrowser = Env("P5M_NO_BROWSER", "") == "";
        bool prepareOnly = false;
        foreach (string a in args)
        {
            if (a == "--no-browser") openBrowser = false;
            // Unpack and stop: the build checks the unpacked files this way.
            if (a == "--prepare") prepareOnly = true;
        }

        string home = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string node = Path.Combine(home, "runtime", "node", "node.exe");
        string backend = Path.Combine(home, "app", "backend");
        string python = Path.Combine(home, "runtime", "python", "python.exe");
        string sidecarDir = Path.Combine(home, "app", "pyremoteplay");
        string data = Env("P5M_DATA_DIR", Path.Combine(home, "data"));
        string port = Env("PORT", "3001");
        string sidecarPort = Env("PYREMOTEPLAY_SIDECAR_PORT", "9555");

        Console.Title = "P5 Manager - starting...";
        Console.WriteLine("==============================================================");
        Console.WriteLine("  P5 Manager is starting. Please wait...");
        Console.WriteLine("  Your browser opens by itself when it is ready.");
        Console.WriteLine("  Keep this window open - closing it stops P5 Manager.");
        Console.WriteLine("==============================================================");
        Console.WriteLine();
        if (!Unpack(home))
        {
            Console.Error.WriteLine("Press Enter to close.");
            if (openBrowser && !prepareOnly) Console.ReadLine();
            return 2;
        }
        if (prepareOnly) return 0;
        if (!File.Exists(node) || !File.Exists(Path.Combine(backend, "src", "index.js")))
        {
            Console.Error.WriteLine("P5 Manager: the app files are missing next to P5Manager.exe.");
            Console.Error.WriteLine("Extract the whole zip and start P5Manager.exe from the extracted folder.");
            Console.Error.WriteLine("Press Enter to close.");
            Console.ReadLine();
            return 2;
        }

        string appData = Path.Combine(data, "app");
        Directory.CreateDirectory(appData);
        foreach (string d in new string[] { "payloads", "downloads", "mkpfs" })
            Directory.CreateDirectory(Path.Combine(data, d));

        CreateKillOnCloseJob();
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        OpenConsoleLog(appData);

        bool hasSidecar = File.Exists(python) && File.Exists(Path.Combine(sidecarDir, "server.py"));
        Process sidecar = null;
        if (hasSidecar)
        {
            sidecar = StartSidecar(python, sidecarDir, appData, sidecarPort);
        }
        else
        {
            Emit("[launcher] Remote Play service is not part of this package");
        }

        Emit("[launcher] starting P5 Manager on port " + port + ", data in " + data);
        string[][] serverEnv = new string[][] {
            new string[] { "NODE_ENV", "production" },
            new string[] { "PORT", port },
            new string[] { "P5M_PORTABLE", "1" },
            new string[] { "DATA_DIR", appData },
            new string[] { "P5M_DB_DIR", appData },
            new string[] { "USER_DATA_DIR", data },
            new string[] { "BUILTIN_DIR", Path.Combine(home, "app", "builtin") },
            new string[] { "PYREMOTEPLAY_SIDECAR_URL", "http://127.0.0.1:" + sidecarPort },
        };
        // The backend calls "7z" by name, as it does on Linux.
        string sevenZip = Path.Combine(home, "runtime", "7zip");
        if (File.Exists(Path.Combine(sevenZip, "7z.exe")))
            Environment.SetEnvironmentVariable("PATH", sevenZip + ";" + Environment.GetEnvironmentVariable("PATH"));
        Process server = Start(node, "src\\index.js", backend, serverEnv);

        string url = "http://localhost:" + port + "/";
        // Asked by address, not as "localhost": that name means ::1 first, the
        // server listens on IPv4 only, and Windows takes two seconds to give up
        // on a refused connection - as long as the request is given, so the
        // launcher kept waiting for a server that had been up for a while.
        string health = "http://127.0.0.1:" + port + "/api/health";
        bool up = false;
        Stopwatch waited = Stopwatch.StartNew();
        int told = 0;
        while (waited.ElapsedMilliseconds < 120000 && !server.HasExited)
        {
            if (Answers(health)) { up = true; break; }
            Thread.Sleep(200);
            // A line every 5 seconds so a slow start does not look like a hang.
            int seconds = (int)(waited.ElapsedMilliseconds / 1000);
            if (seconds >= told + 5)
            {
                told = seconds - seconds % 5;
                Emit("[launcher] still starting... (" + told + " s)");
            }
        }
        if (up)
        {
            Console.Title = "P5 Manager - running on " + url;
            Console.WriteLine();
            Console.WriteLine("==============================================================");
            Console.WriteLine("  P5 Manager is ready: " + url);
            Console.WriteLine("  Close this window to stop it.");
            Console.WriteLine("==============================================================");
            Console.WriteLine();
            if (openBrowser)
            {
                try { Process.Start(url); }
                catch (Exception e) { Emit("[launcher] open " + url + " in your browser (" + e.Message + ")"); }
            }
        }
        else if (!server.HasExited)
        {
            Emit("[launcher] the server did not answer on " + url + " yet - see the log above");
        }

        server.WaitForExit();
        int code = server.ExitCode;
        // 75 = the app installed an update of itself and wants to be started
        // again (backend/src/routes/update.js). The Remote Play service is
        // started again too, since the update may have brought a newer one.
        // An updated app that then stops with an error gets a few more starts:
        // after two failed ones its loader goes back to the previous version.
        int retries = 0;
        bool updated = false;
        while (code == 75 || (updated && code != 0 && retries < 3))
        {
            if (code == 75) { updated = true; retries = 0; }
            else retries++;
            Emit("[launcher] restarting P5 Manager after an update");
            if (sidecar != null)
            {
                try { if (!sidecar.HasExited) { sidecar.Kill(); sidecar.WaitForExit(5000); } } catch { }
                sidecar = StartSidecar(python, sidecarDir, appData, sidecarPort);
            }
            server = Start(node, "src\\index.js", backend, serverEnv);
            server.WaitForExit();
            code = server.ExitCode;
        }
        if (code != 0)
        {
            Console.Error.WriteLine("[launcher] P5 Manager stopped with exit code " + code + ". Press Enter to close.");
            if (openBrowser) Console.ReadLine();
        }
        return code;
    }
}
