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
//   runtime\node\node.exe
//   runtime\python\python.exe     (optional)
//   data\                         created on first start: database, payloads, downloads
//
// Built with the .NET Framework C# 5 compiler that ships with Windows, so
// no newer language features here.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
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

    static Process Start(string exe, string args, string workDir, string[][] env)
    {
        ProcessStartInfo psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false;   // share this console: the children's logs show up here
        psi.WorkingDirectory = workDir;
        foreach (string[] kv in env) psi.EnvironmentVariables[kv[0]] = kv[1];
        Process p = Process.Start(psi);
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
        Console.WriteLine("[launcher] starting Remote Play service on 127.0.0.1:" + sidecarPort
            + (dir == packaged ? "" : " (updated copy)"));
        return Start(python, args, dir, new string[][] {
            new string[] { "PYREMOTEPLAY_SIDECAR_HOST", "127.0.0.1" },
            new string[] { "PYREMOTEPLAY_SIDECAR_PORT", sidecarPort },
            new string[] { "PYTHONUNBUFFERED", "1" },
            new string[] { "PYTHONIOENCODING", "utf-8" },
        });
    }

    static int Main(string[] args)
    {
        bool openBrowser = Env("P5M_NO_BROWSER", "") == "";
        foreach (string a in args) if (a == "--no-browser") openBrowser = false;

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
        Console.WriteLine("  The first start can take a minute while Windows checks the");
        Console.WriteLine("  files. Your browser opens by itself when it is ready.");
        Console.WriteLine("  Keep this window open - closing it stops P5 Manager.");
        Console.WriteLine("==============================================================");
        Console.WriteLine();
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

        bool hasSidecar = File.Exists(python) && File.Exists(Path.Combine(sidecarDir, "server.py"));
        Process sidecar = null;
        if (hasSidecar)
        {
            sidecar = StartSidecar(python, sidecarDir, appData, sidecarPort);
        }
        else
        {
            Console.WriteLine("[launcher] Remote Play service is not part of this package");
        }

        Console.WriteLine("[launcher] starting P5 Manager on port " + port + ", data in " + data);
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
        Process server = Start(node, "src\\index.js", backend, serverEnv);

        string url = "http://localhost:" + port + "/";
        bool up = false;
        for (int i = 0; i < 240 && !server.HasExited; i++)
        {
            if (Answers(url + "api/health")) { up = true; break; }
            Thread.Sleep(500);
            // A line every 5 seconds so a slow start does not look like a hang.
            if (i > 0 && i % 10 == 0)
                Console.WriteLine("[launcher] still starting... (" + (i / 2) + " s)");
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
                catch (Exception e) { Console.WriteLine("[launcher] open " + url + " in your browser (" + e.Message + ")"); }
            }
        }
        else if (!server.HasExited)
        {
            Console.WriteLine("[launcher] the server did not answer on " + url + " yet - see the log above");
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
            Console.WriteLine("[launcher] restarting P5 Manager after an update");
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
