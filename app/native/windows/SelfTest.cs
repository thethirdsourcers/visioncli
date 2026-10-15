using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using static VcliWin.Native;

namespace VcliWin
{
    // `vcli-win.exe --selftest`: every method that doesn't need a person, through the same Handle() the protocol
    // uses. One "PASS|FAIL|SKIP name: detail" line per check; exit code 1 if anything failed.
    static class SelfTest
    {
        static int failed, passed, skipped;
        static string dir;

        sealed class Skip : Exception { public Skip(string m) : base(m) { } }

        static void Check(string name, Func<string> f)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var detail = f();
                passed++;
                Console.WriteLine($"PASS {name}: {detail} ({sw.ElapsedMilliseconds} ms)");
            }
            catch (Skip s) { skipped++; Console.WriteLine($"SKIP {name}: {s.Message}"); }
            catch (Exception e)
            {
                failed++;
                var inner = e is AggregateException ae && ae.InnerException != null ? ae.InnerException : e;
                Console.WriteLine($"FAIL {name}: {inner.GetType().Name}: {inner.Message}");
            }
            Console.Out.Flush();
        }

        static void Assert(bool ok, string what) { if (!ok) throw new Exception("expected " + what); }
        // Params go through JSON like the protocol's (numbers arrive as doubles), not as boxed ints.
        static object Call(string method, params object[] kv) =>
            Program.Handle(method, new Args((Dictionary<string, object>)Json.Parse(Json.Write(Json.O(kv)))));
        static Dictionary<string, object> Obj(object o) => (Dictionary<string, object>)o;
        static List<object> Arr(object o) => (List<object>)o;
        static string J(object o) { var s = Json.Write(o); return s.Length > 160 ? s.Substring(0, 160) + "…" : s; }

        public static int Run()
        {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            dir = Path.Combine(Path.GetTempPath(), "vcli-win-selftest-" + Process.GetCurrentProcess().Id);
            Directory.CreateDirectory(dir);
            var events = new ConcurrentQueue<string>();
            Hooks.Emit = (e, d) => events.Enqueue(e + " " + Json.Write(d));

            Check("hello", () => J(Call("hello")));

            Check("json", () =>
            {
                var o = Json.Parse("{\"a\":[1,2.5,-3e2,true,false,null],\"s\":\"x\\\"y\\n\\u00e9 😀\"}") as Dictionary<string, object>;
                Assert(Arr(o["a"]).Count == 6 && (double)Arr(o["a"])[2] == -300, "numbers");
                Assert((string)o["s"] == "x\"y\né 😀", "string escapes");
                var back = Json.Write(o);
                Assert(Json.Write(Json.Parse(back)) == back, "round trip");
                return back;
            });

            Check("keys.parse", () =>
            {
                var c = Keys.Parse("cmd+shift+s");
                Assert(c.Count == 1 && c[0].Vk == 'S' && c[0].Mods.Contains(Keys.VK_LWIN) && c[0].Mods.Contains(Keys.VK_SHIFT), "cmd+shift+s");
                Assert(Keys.Parse("option+left")[0].Extended && Keys.Parse("option+left")[0].Mods[0] == Keys.VK_MENU, "option+left");
                Assert(Keys.Parse("delete")[0].Vk == 0x08 && Keys.Parse("forwarddelete")[0].Vk == 0x2E, "delete = backspace");
                Assert(Keys.Parse("f24")[0].Vk == 0x87, "f24");
                Assert(Keys.Parse("vk:0xE8")[0].Vk == 0xE8 && Keys.Parse("shift+vk:65")[0].Vk == 65, "raw vk:");
                Assert(Keys.Parse("ctrl+shift+s enter").Count == 2, "sequence");
                Assert(Keys.Parse("ctrl++")[0].Mods.Contains(Keys.VK_CONTROL), "ctrl++");
                Assert(Keys.Parse("ctrl+/")[0].Vk != 0, "punctuation via VkKeyScan");
                try { Keys.Parse("ctrl+bogus"); throw new Exception("bogus key accepted"); } catch (ArgumentException) { }
                try { Keys.Parse("cmd"); throw new Exception("modifier-only accepted"); } catch (ArgumentException) { }
                return "ok";
            });

            Dictionary<string, object> primary = null;
            Check("displays", () =>
            {
                var d = Arr(Call("displays"));
                Assert(d.Count > 0, "at least one display");
                primary = Obj(d.FirstOrDefault(x => (bool)Obj(x)["primary"]) ?? d[0]);
                return J(d);
            });

            Check("pointer", () => J(Call("pointer")));

            List<object> wins = null;
            Check("windows", () =>
            {
                wins = Arr(Call("windows", "excludePid", Process.GetCurrentProcess().Id));
                foreach (var w in wins) Assert(Obj(w)["hwnd"] is string && Obj(w).ContainsKey("bounds"), "window shape");
                return wins.Count + " windows: " + string.Join(", ", wins.Take(6).Select(w => Obj(w)["app"] + " — " + Obj(w)["title"]));
            });

            Check("activeWindow", () => J(Call("activeWindow")));

            Check("capture.screen", () =>
            {
                Assert(primary != null, "a display");
                var f = Path.Combine(dir, "screen.jpg");
                var r = Obj(Call("capture", "rect", Json.O("x", primary["x"], "y", primary["y"], "width", primary["width"], "height", primary["height"]), "maxDim", 800, "file", f));
                Assert(File.Exists(f) && new FileInfo(f).Length > 1000, "a JPEG");
                Assert(Convert.ToInt32(r["width"]) <= 800 && Convert.ToInt32(r["height"]) <= 800, "≤ maxDim");
                using (var img = Image.FromFile(f)) Assert(img.Width == Convert.ToInt32(r["width"]), "reported size");
                return J(r);
            });

            Check("capture.window", () =>
            {
                if (wins == null || wins.Count == 0) throw new Skip("no windows");
                var f = Path.Combine(dir, "window.jpg");
                var r = Obj(Call("capture", "hwnd", Obj(wins[0])["hwnd"], "maxDim", 1568, "file", f));
                Assert(File.Exists(f), "a JPEG");
                return Obj(wins[0])["app"] + " " + J(r);
            });

            Check("clipboard.text", () =>
            {
                string old = (string)Call("getClipboardText");
                const string s = "vcli selftest é 😀";
                Call("setClipboardText", "text", s);
                var got = (string)Call("getClipboardText");
                Call("setClipboardText", "text", old);
                Assert(got == s, "the same text back, got '" + got + "'");
                return "round trip ok";
            });

            Check("clipboardImage", () =>
            {
                var f = Path.Combine(dir, "clip.png");
                bool r = (bool)Call("clipboardImage", "file", f);
                return r ? "image saved" : "no image (fine)";
            });

            Check("processes.self", () =>
            {
                int me = Process.GetCurrentProcess().Id;
                var all = Arr(Call("processes", "names", new List<object> { "vcli-win" }));
                var mine = all.Select(Obj).FirstOrDefault(p => Convert.ToInt32(p["pid"]) == me);
                Assert(mine != null, "own process in the list");
                if (Environment.Is64BitProcess)
                {
                    Assert(((string)mine["cmdline"]).Contains("--selftest"), "cmdline with --selftest, got " + mine["cmdline"]);
                    string cwd = Environment.CurrentDirectory.TrimEnd('\\');
                    Assert(string.Equals(((string)mine["cwd"])?.TrimEnd('\\'), cwd, StringComparison.OrdinalIgnoreCase), "cwd " + cwd + ", got " + mine["cwd"]);
                }
                return J(mine);
            });

            Check("processes.all", () =>
            {
                var all = Arr(Call("processes"));
                Assert(all.Count > 10, "many processes");
                return all.Count + " processes";
            });

            Check("hooks", () =>
            {
                Call("hooks.start");
                try
                {
                    while (events.TryDequeue(out _)) { }
                    // Our own tagged input must not show up…
                    Input.Combo("f24");
                    Thread.Sleep(300);
                    var own = events.Where(e => e.StartsWith("key")).ToList();
                    Assert(own.Count == 0, "own input dropped, got " + string.Join("; ", own));
                    // …someone else's injected input must, flagged.
                    var inputs = new[]
                    {
                        new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = 0x10 } } },
                        new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = 0x10, dwFlags = KEYEVENTF_KEYUP } } },
                    };
                    if (SendInput(2, inputs, Marshal.SizeOf<INPUT>()) == 0) throw new Skip("SendInput blocked (no interactive desktop)");
                    for (int i = 0; i < 20 && !events.Any(e => e.StartsWith("key")); i++) Thread.Sleep(50);
                    var other = events.Where(e => e.StartsWith("key")).ToList();
                    Assert(other.Any(e => e.Contains("\"vk\":160") || e.Contains("\"vk\":16")), "foreign shift seen, got " + string.Join("; ", other));
                    Assert(other.All(e => e.Contains("\"injected\":true")), "injected flag");
                    return string.Join("; ", other);
                }
                finally { Call("hooks.stop"); }
            });

            Check("audioDevices", () => J(Call("audioDevices")));

            Check("record", () =>
            {
                var devs = Obj(Call("audioDevices"));
                if (Arr(devs["inputs"]).Count == 0) throw new Skip("no microphone");
                var f = Path.Combine(dir, "rec.wav");
                int levels = 0;
                Audio.OnLevel = l => Interlocked.Increment(ref levels);
                Call("record.start", "file", f, "device", null);
                Thread.Sleep(700);
                var snap = Path.Combine(dir, "snap.wav");
                Assert((bool)Call("record.snapshot", "file", snap) && new FileInfo(snap).Length > 44, "a snapshot");
                Thread.Sleep(300);
                var r = Obj(Call("record.stop"));
                Assert(Convert.ToDouble(r["seconds"]) > 0.5, "≥ 0.5 s recorded");
                Assert(levels > 15, "~30 levels/s, got " + levels);
                return J(r) + ", " + levels + " levels";
            });

            string speech = Path.Combine(dir, "speech.wav");
            Check("voices", () =>
            {
                var v = Arr(Call("voices"));
                Assert(v.Count > 0, "a SAPI voice");
                return J(v);
            });

            Check("speak", () =>
            {
                Call("speak", "text", "VisionCLI self test.", "voice", null, "rate", 2, "file", speech);
                var b = File.ReadAllBytes(speech);
                Audio.ParseWav(b, out var fmt, out _, out int len);
                Assert(len > 1000, "audio data");
                return b.Length + " bytes";
            });

            Check("play+stop", () =>
            {
                var devs = Obj(Call("audioDevices"));
                if (Arr(devs["outputs"]).Count == 0) throw new Skip("no audio output");
                if (!File.Exists(speech)) throw new Skip("no speech file");
                var sw = Stopwatch.StartNew();
                var t = Task.Run(() => Call("play", "file", speech, "device", null, "token", "t1"));
                Thread.Sleep(200);
                Call("play.stop", "token", "t1");
                Assert(t.Wait(3000), "play returns soon after play.stop");
                return "stopped after " + sw.ElapsedMilliseconds + " ms";
            });

            Check("loopback", () =>
            {
                var devs = Obj(Call("audioDevices"));
                if (Arr(devs["outputs"]).Count == 0) throw new Skip("no audio output");
                int bytes = 0;
                Loopback.OnPcm = b => Interlocked.Add(ref bytes, b.Length);
                try { Call("loopback.start"); }
                catch (Exception e) when (e.Message.Contains("no audio output")) { throw new Skip("no audio endpoint"); }
                Thread.Sleep(700);
                Call("loopback.stop");
                // Silence still arrives (padded): ~0.7 s of 16 kHz 16-bit.
                Assert(bytes >= 16000, "~32 KB of PCM in 0.7 s, got " + bytes);
                return bytes + " bytes";
            });

            Check("micstream", () =>
            {
                var devs = Obj(Call("audioDevices"));
                if (Arr(devs["inputs"]).Count == 0) throw new Skip("no microphone");
                int bytes = 0;
                MicStream.OnPcm = b => Interlocked.Add(ref bytes, b.Length);
                Call("micstream.start", "device", null);
                Thread.Sleep(700);
                Call("micstream.stop");
                Assert(bytes >= 12000, "PCM from the microphone in 0.7 s, got " + bytes);
                return bytes + " bytes";
            });

            Notepad();

            try { Directory.Delete(dir, true); } catch { }
            Console.WriteLine($"selftest: {passed} passed, {failed} failed, {skipped} skipped");
            return failed > 0 ? 1 : 0;
        }

        // Notepad round trip: UIA walk, SendInput typing read back through UIA, key combos, setValue.
        static void Notepad()
        {
            IntPtr hwnd = IntPtr.Zero;
            uint pid = 0;
            Check("notepad.start", () =>
            {
                var before = new HashSet<IntPtr>();
                EnumWindows((h, l) => { before.Add(h); return true; }, IntPtr.Zero);
                Process.Start("notepad.exe");
                for (int i = 0; i < 100 && hwnd == IntPtr.Zero; i++)
                {
                    Thread.Sleep(100);
                    EnumWindows((h, l) =>
                    {
                        if (!before.Contains(h) && IsWindowVisible(h) && Desktop.ClassName(h) == "Notepad") { hwnd = h; return false; }
                        return true;
                    }, IntPtr.Zero);
                }
                if (hwnd == IntPtr.Zero) throw new Skip("notepad window didn't appear");
                GetWindowThreadProcessId(hwnd, out pid);
                Thread.Sleep(500);
                return "hwnd " + hwnd + " pid " + pid;
            });
            if (hwnd == IntPtr.Zero) return;
            try
            {
                Check("focus", () =>
                {
                    Assert((bool)Call("focus", "hwnd", hwnd.ToInt64().ToString()), "notepad in front");
                    var a = Obj(Call("activeWindow"));
                    return a["app"] + " — " + a["title"];
                });

                Check("elements", () =>
                {
                    var r = Obj(Call("elements"));
                    var els = Arr(r["elements"]).Select(Obj).ToList();
                    Assert(els.Count > 0, "elements");
                    Assert(els.Any(e => (string)e["role"] == "Edit" || (string)e["role"] == "Document"), "an Edit/Document");
                    return r["app"] + ": " + els.Count + " elements, e.g. " + string.Join(", ", els.Take(8).Select(e => e["role"] + " '" + e["label"] + "'"));
                });

                const string typed = "Hello vcli é ✓ 😀";
                Check("type+windowText", () =>
                {
                    Call("key", "combo", "ctrl+a");
                    Call("type", "text", typed + "\nsecond line");
                    Thread.Sleep(500);
                    var t = Obj(Call("windowText", "max", 2000));
                    Assert(((string)t["text"]).Contains(typed) && ((string)t["text"]).Contains("second line"), "the typed text back, got '" + t["text"] + "'");
                    return J(t);
                });

                Check("key combo", () =>
                {
                    Call("key", "combo", "ctrl+a");
                    Call("key", "combo", "delete");
                    Call("type", "text", "replaced");
                    Thread.Sleep(400);
                    var text = (string)Obj(Call("windowText", "max", 2000))["text"];
                    Assert(text.Contains("replaced") && !text.Contains("Hello"), "ctrl+a, delete, type → 'replaced', got '" + text + "'");
                    return text;
                });

                Check("isSecure", () =>
                {
                    Assert(!(bool)Call("isSecure", "focused", true), "notepad's editor isn't a password field");
                    return "false";
                });

                Check("setValue", () =>
                {
                    var els = Arr(Obj(Call("elements"))["elements"]).Select(Obj).ToList();
                    var ed = els.FirstOrDefault(e => (string)e["role"] == "Edit" || (string)e["role"] == "Document");
                    if (ed == null) throw new Exception("no editor element");
                    if (!(bool)Call("setValue", "id", ed["id"], "text", "set by uia"))
                        throw new Skip("editor has no writable ValuePattern (the Windows 11 Notepad's RichEdit)");
                    var text = (string)Obj(Call("windowText", "max", 2000))["text"];
                    Assert(text.Contains("set by uia"), "the value back, got '" + text + "'");
                    return "ok";
                });

                Check("press", () =>
                {
                    var els = Arr(Obj(Call("elements"))["elements"]).Select(Obj).ToList();
                    // A menu item / tab that just expands is safe to press.
                    var m = els.FirstOrDefault(e => (string)e["role"] == "MenuItem");
                    if (m == null) throw new Skip("no menu item");
                    bool ok = (bool)Call("press", "id", m["id"]);
                    Call("key", "combo", "esc");
                    Call("key", "combo", "esc");
                    Assert(ok, "press returns true");
                    return "pressed " + m["label"];
                });

                Check("mouse", () =>
                {
                    var b = Desktop.Bounds(hwnd);
                    int cx = b.Left + b.Width / 2, cy = b.Top + b.Height / 2;
                    Call("move", "x", cx, "y", cy);
                    var p = Obj(Call("pointer"));
                    Assert(Convert.ToInt32(p["x"]) == cx && Convert.ToInt32(p["y"]) == cy, "pointer at " + cx + "," + cy + ", got " + J(p));
                    Call("click", "x", cx, "y", cy, "button", "left", "count", 1);
                    Call("scroll", "dx", 0, "dy", -2);
                    Call("drag", "x1", cx, "y1", cy, "x2", cx + 20, "y2", cy);
                    return "move/click/scroll/drag ok";
                });
            }
            finally
            {
                try { Process.GetProcessById((int)pid).Kill(); } catch { }
            }
        }
    }
}
