using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VcliWin
{
    // vcli-win.exe: the app's Windows helper. One JSON request per stdin line, one JSON reply/event per stdout line
    // (protocol: app/src/main/platform/win32/protocol.ts). Exits when stdin closes, i.e. when the app goes away.
    //   vcli-win.exe             serve the protocol
    //   vcli-win.exe --selftest  run the checks that don't need a user (Windows CI)
    static class Program
    {
        public static readonly string Version = typeof(Program).Assembly.GetName().Version.ToString(3);
        static readonly BlockingCollection<string> outbox = new BlockingCollection<string>(new ConcurrentQueue<string>());

        static int Main(string[] args)
        {
            if (Array.IndexOf(args, "--selftest") >= 0) return SelfTest.Run();
            if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine(Version); return 0; }

            // Plenty of pool threads: play and slow UIA requests wait a long time, and the rest shouldn't queue behind them.
            ThreadPool.SetMinThreads(32, 8);

            // One writer thread: lines from concurrent requests and the hooks never interleave, and the hooks never
            // wait on a full pipe.
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false, NewLine = "\n" };
            var writer = new Thread(() =>
            {
                foreach (var line in outbox.GetConsumingEnumerable())
                {
                    try
                    {
                        stdout.Write(line);
                        stdout.Write('\n');
                        if (outbox.Count == 0) stdout.Flush();
                    }
                    catch (IOException) { Environment.Exit(0); } // the app is gone
                }
            }) { IsBackground = true, Name = "stdout" };
            writer.Start();

            Hooks.Emit = Event;
            Audio.OnLevel = l => Event("level", Json.O("level", Math.Round(l, 3)));
            Loopback.OnPcm = b => Event("loopback", Json.O("data", Convert.ToBase64String(b)));
            MicStream.OnPcm = b => Event("mic", Json.O("data", Convert.ToBase64String(b)));

            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dispatch(line);
            }
            // stdin closed: the app quit or crashed. Process exit removes the hooks and stops waveIn.
            try { Audio.Cancel(); Loopback.Stop(); MicStream.Stop(); } catch { }
            return 0;
        }

        public static void Event(string name, Dictionary<string, object> data)
        {
            var sb = new StringBuilder(64);
            sb.Append("{\"event\":");
            Json.Quote(sb, name);
            sb.Append(",\"data\":");
            Json.Write(sb, data);
            sb.Append('}');
            outbox.Add(sb.ToString());
        }

        static void Reply(object id, object result, string error)
        {
            var sb = new StringBuilder();
            sb.Append("{\"id\":");
            Json.Write(sb, id);
            if (error != null) { sb.Append(",\"error\":"); Json.Quote(sb, error); }
            else { sb.Append(",\"result\":"); Json.Write(sb, result); }
            sb.Append('}');
            outbox.Add(sb.ToString());
        }

        static void Dispatch(string line)
        {
            object id = null;
            string method;
            Args args;
            try
            {
                var req = Json.Parse(line) as Dictionary<string, object> ?? throw new FormatException("request is not an object");
                req.TryGetValue("id", out id);
                method = req.TryGetValue("method", out var m) ? m as string : null;
                args = new Args(req.TryGetValue("params", out var p) ? p : null);
                if (method == null) throw new FormatException("request without method");
            }
            catch (Exception e)
            {
                Log.Write("bad request: " + e.Message);
                if (id != null) Reply(id, null, "bad request: " + e.Message);
                return;
            }
            // Concurrent: each request on the pool; the handlers serialise what must be serial (input, UIA, audio).
            var opts = method == "play" ? TaskCreationOptions.LongRunning : TaskCreationOptions.None;
            Task.Factory.StartNew(() =>
            {
                try { Reply(id, Handle(method, args), null); }
                catch (Exception e)
                {
                    var inner = e is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : e;
                    Reply(id, null, inner.Message);
                }
            }, CancellationToken.None, opts, TaskScheduler.Default);
        }

        static int? OptInt(Args a, string k) => a.Has(k) ? a.Int(k) : (int?)null;

        public static object Handle(string method, Args a)
        {
            switch (method)
            {
                case "hello": return Json.O("version", Version, "dpiAware", DpiAware(), "arch", Arch());

                // ── Desktop ──
                case "displays": return Desktop.Displays();
                case "pointer": return Desktop.Pointer();
                case "windows":
                    {
                        var list = new List<object>();
                        foreach (var w in Desktop.Windows(a.Int("excludePid"))) list.Add(w.ToJson());
                        return list;
                    }
                case "activeWindow": return Desktop.Active(a.Int("excludePid"))?.ToJson();
                case "focus": return Desktop.Focus(Desktop.ParseHwnd(a.Need("hwnd")));
                case "capture": return Capture.Run(a);
                case "clipboardImage": return Clip.Image(a.Need("file"));
                case "setClipboardText": return Clip.SetText(a.Str("text", ""));
                case "getClipboardText": return Clip.GetText();

                // ── Input ──
                case "move": Input.Move(a.Int("x"), a.Int("y")); return true;
                case "click": Input.Click(a.Int("x"), a.Int("y"), a.Str("button", "left"), a.Int("count", 1)); return true;
                case "type": Input.Type(a.Str("text", "")); return true;
                case "key": Input.Combo(a.Need("combo")); return true;
                case "scroll": Input.Scroll(a.Num("dx"), a.Num("dy"), OptInt(a, "x"), OptInt(a, "y")); return true;
                case "drag": Input.Drag(a.Int("x1"), a.Int("y1"), a.Int("x2"), a.Int("y2")); return true;

                // ── Hooks ──
                case "hooks.start": return Hooks.Start();
                case "hooks.stop": return Hooks.Stop();

                // ── UI Automation ──
                case "elements": return Uia.Run(() => Uia.Elements(a.Str("app"), a.Int("excludePid")));
                case "press": return Uia.Run(() => Uia.Press(a.Int("id")));
                case "setValue": return Uia.Run(() => Uia.SetValue(a.Int("id"), a.Str("text", "")));
                case "isSecure": return Uia.Run(() => Uia.IsSecure(a));
                case "windowText": return Uia.Run(() => Uia.WindowText(a.Int("max", 4000), a.Int("excludePid")));

                // ── Audio ──
                case "audioDevices": return Audio.Devices();
                case "record.start": return Audio.Start(a.Need("file"), a.Str("device"));
                case "record.snapshot": return Audio.Snapshot(a.Need("file"));
                case "record.stop": return Audio.Stop();
                case "record.cancel": return Audio.Cancel();
                case "loopback.start": return Loopback.Start();
                case "loopback.stop": return Loopback.Stop();
                case "micstream.start": return MicStream.Start(a.Str("device"));
                case "micstream.stop": return MicStream.Stop();
                case "play": return Audio.Play(a.Need("file"), a.Str("device"), a.Str("token"));
                case "play.stop": return Audio.StopPlay(a.Str("token"));

                // ── Speech ──
                case "voices": return Speech.Voices();
                case "speak": return Speech.Speak(a.Str("text", ""), a.Str("voice"), a.Int("rate"), a.Need("file"));

                // ── Processes ──
                case "processes": return Processes.List(a.Strs("names"));
            }
            throw new ArgumentException("unknown method '" + method + "'");
        }

        public static bool DpiAware()
        {
            // DPI_AWARENESS_PER_MONITOR_AWARE = 2 (v2 contexts also report 2); 1607+ API.
            try { return Native.GetAwarenessFromDpiAwarenessContext(Native.GetThreadDpiAwarenessContext()) == 2; }
            catch { return false; }
        }

        public static string Arch()
        {
            try { return RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(); }
            catch { return Environment.Is64BitProcess ? "x64" : "x86"; }
        }
    }

    static class Log
    {
        static readonly object gate = new object();
        // stderr: the app copies it into visioncli.log.
        public static void Write(string msg)
        {
            lock (gate) { try { Console.Error.WriteLine("vcli-win: " + msg); } catch { } }
        }
    }
}
