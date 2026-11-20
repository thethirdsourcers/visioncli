using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using static VcliWin.Native;

namespace VcliWin
{
    // UI Automation (UIElements in Control.swift). Calls run one at a time on a dedicated MTA thread: Microsoft
    // recommends UIA clients stay off UI/STA threads, and serialising keeps the id → element table consistent.
    static class Uia
    {
        static readonly BlockingCollection<Action> queue = new BlockingCollection<Action>();
        static readonly Dictionary<int, AutomationElement> ids = new Dictionary<int, AutomationElement>();

        static Uia()
        {
            var t = new Thread(() => { foreach (var a in queue.GetConsumingEnumerable()) a(); }) { IsBackground = true, Name = "uia" };
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
        }

        public static T Run<T>(Func<T> f)
        {
            var tcs = new TaskCompletionSource<T>();
            queue.Add(() => { try { tcs.SetResult(f()); } catch (Exception e) { tcs.SetException(e); } });
            try { return tcs.Task.Result; }
            catch (AggregateException e) { throw e.InnerException; }
        }

        // The macOS limits.
        const int MaxDepth = 30, MaxItems = 350, MaxNodes = 5000;
        static readonly TimeSpan MaxTime = TimeSpan.FromSeconds(4);

        static CacheRequest Cache()
        {
            var c = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.Full };
            foreach (var p in new AutomationProperty[]
            {
                AutomationElement.ControlTypeProperty, AutomationElement.NameProperty, AutomationElement.HelpTextProperty,
                AutomationElement.AutomationIdProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.IsOffscreenProperty,
                AutomationElement.IsPasswordProperty, AutomationElement.IsInvokePatternAvailableProperty,
                AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty,
                AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
                AutomationElement.IsTextPatternAvailableProperty, ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty,
            }) c.Add(p);
            return c;
        }

        static object Get(AutomationElement e, AutomationProperty p)
        {
            try { var v = e.GetCachedPropertyValue(p, true); return v == AutomationElement.NotSupported ? null : v; }
            catch { try { return e.GetCurrentPropertyValue(p, true); } catch { return null; } }
        }
        static bool Flag(AutomationElement e, AutomationProperty p) => Get(e, p) is bool b && b;
        static string Text(AutomationElement e, AutomationProperty p) => Get(e, p) as string ?? "";

        enum Next { Stop, Descend, Skip }

        /// <summary>Depth-first over the ControlView with the node/time/depth limits; visit says whether to go into
        /// the element's children, skip them, or stop.</summary>
        static void Walk(AutomationElement root, CacheRequest cache, Func<AutomationElement, Next> visit, int maxNodes = MaxNodes, TimeSpan? maxTime = null)
        {
            var walker = TreeWalker.ControlViewWalker;
            var sw = Stopwatch.StartNew();
            var limit = maxTime ?? MaxTime;
            int visited = 0;
            bool stop = false;
            void Go(AutomationElement n, int depth)
            {
                if (stop || depth >= MaxDepth || visited >= maxNodes || sw.Elapsed > limit) return;
                visited++;
                var next = visit(n);
                if (next == Next.Stop) { stop = true; return; }
                if (next == Next.Skip) return;
                AutomationElement child = null;
                try { child = walker.GetFirstChild(n, cache); } catch { }
                while (child != null && !stop)
                {
                    Go(child, depth + 1);
                    if (stop || visited >= maxNodes || sw.Elapsed > limit) return;
                    try { child = walker.GetNextSibling(child, cache); } catch { child = null; }
                }
            }
            Go(root, 0);
        }

        static WinInfo Target(string app, int excludePid)
        {
            if (!string.IsNullOrWhiteSpace(app))
            {
                var wins = Desktop.Windows(excludePid);
                string q = app.Trim();
                string bare(string s) => s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? s.Substring(0, s.Length - 4) : s;
                foreach (var w in wins) if (string.Equals(w.App, q, StringComparison.OrdinalIgnoreCase) || string.Equals(bare(w.Exe), bare(q), StringComparison.OrdinalIgnoreCase)) return w;
                foreach (var w in wins) if (w.App.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0 || w.Exe.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) return w;
                foreach (var w in wins) if (w.Title.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) return w;
                return null;
            }
            return Desktop.Active(excludePid);
        }

        static readonly HashSet<string> Editable = new HashSet<string> { "Edit", "Document", "ComboBox", "Spinner" };
        // Shown when labelled, like StaticText/Image on macOS: context for the model, not actions.
        static readonly HashSet<string> Context = new HashSet<string> { "Text", "Image" };
        // UIA reports a press-able Hyperlink, MenuItem etc. through patterns; these roles are actionable by nature.
        static readonly HashSet<string> Clickable = new HashSet<string> { "Button", "Hyperlink", "MenuItem", "TabItem", "CheckBox", "RadioButton", "SplitButton", "ListItem", "TreeItem" };

        public static string Role(AutomationElement e)
        {
            var ct = Get(e, AutomationElement.ControlTypeProperty) as ControlType;
            if (ct == null) return "";
            var name = ct.ProgrammaticName ?? "";
            return name.StartsWith("ControlType.") ? name.Substring("ControlType.".Length) : name;
        }

        static string Clean(string s, int max = 100)
        {
            s = Regex.Replace(s ?? "", @"\s+", " ").Trim();
            return s.Length > max ? s.Substring(0, max) : s;
        }

        public static Dictionary<string, object> Elements(string app, int excludePid)
        {
            ids.Clear();
            var t = Target(app, excludePid);
            var items = new List<object>();
            if (t == null) return Json.O("app", app ?? "", "elements", items);
            var cache = Cache();
            AutomationElement root;
            using (cache.Activate()) root = AutomationElement.FromHandle(t.Hwnd);
            int next = 1;
            Walk(root, cache, n =>
            {
                if (items.Count >= MaxItems) return Next.Stop;
                string role = Role(n);
                bool secure = Flag(n, AutomationElement.IsPasswordProperty);
                bool actionable = Flag(n, AutomationElement.IsInvokePatternAvailableProperty) || Flag(n, AutomationElement.IsTogglePatternAvailableProperty)
                    || Flag(n, AutomationElement.IsSelectionItemPatternAvailableProperty) || Flag(n, AutomationElement.IsExpandCollapsePatternAvailableProperty)
                    || Flag(n, AutomationElement.IsValuePatternAvailableProperty) || Editable.Contains(role) || Clickable.Contains(role) || secure;
                bool context = !actionable && Context.Contains(role);
                if (!actionable && !context) return Next.Descend;
                if (Flag(n, AutomationElement.IsOffscreenProperty)) return Next.Descend;
                var r = Get(n, AutomationElement.BoundingRectangleProperty) is System.Windows.Rect rr ? rr : System.Windows.Rect.Empty;
                if (r.IsEmpty || r.Width <= 1 || r.Height <= 1) return Next.Descend;
                string label = Text(n, AutomationElement.NameProperty).Trim();
                if (label == "") label = Text(n, AutomationElement.HelpTextProperty).Trim();
                if (label == "") label = Text(n, AutomationElement.AutomationIdProperty).Trim();
                if (label == "" && !secure && Editable.Contains(role)) label = Text(n, ValuePattern.ValueProperty);
                if (label == "" && context) return Next.Descend;
                items.Add(Json.O("id", next, "role", role, "label", secure ? "(password field)" : Clean(label),
                    "x", (int)Math.Round(r.X), "y", (int)Math.Round(r.Y), "w", (int)Math.Round(r.Width), "h", (int)Math.Round(r.Height)));
                ids[next++] = n;
                return Next.Descend;
            });
            return Json.O("app", t.App, "elements", items);
        }

        /// <summary>Patterns can block while the app runs a modal loop (a button that opens a dialog): give up waiting
        /// after a while and report success, since the action was delivered (a fallback real click would press twice).</summary>
        static bool Patiently(Action a, int ms = 10000)
        {
            var task = Task.Run(a);
            try { return task.Wait(ms) || true; }
            catch (AggregateException) { return false; }
        }

        public static bool Press(int id)
        {
            if (!ids.TryGetValue(id, out var e)) return false;
            try
            {
                if (e.TryGetCurrentPattern(InvokePattern.Pattern, out var ip)) return Patiently(() => ((InvokePattern)ip).Invoke());
                if (e.TryGetCurrentPattern(TogglePattern.Pattern, out var tp)) return Patiently(() => ((TogglePattern)tp).Toggle());
                if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var sp)) return Patiently(() => ((SelectionItemPattern)sp).Select());
                if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var ep))
                {
                    var ec = (ExpandCollapsePattern)ep;
                    return Patiently(() =>
                    {
                        if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) ec.Collapse(); else ec.Expand();
                    });
                }
            }
            catch (Exception ex) { Log.Write("uia press: " + ex.Message); }
            return false;
        }

        public static bool SetValue(int id, string text)
        {
            if (!ids.TryGetValue(id, out var e)) return false;
            try
            {
                if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out var vp)) return false;
                var v = (ValuePattern)vp;
                if (v.Current.IsReadOnly) return false;
                try { e.SetFocus(); } catch { }
                v.SetValue(text ?? "");
                return true;
            }
            catch (Exception ex) { Log.Write("uia setValue: " + ex.Message); return false; }
        }

        public static bool IsSecure(Args a)
        {
            try
            {
                if (a.Has("id")) return ids.TryGetValue(a.Int("id"), out var e) && e.Current.IsPassword;
                if (a.Has("x") && a.Has("y"))
                {
                    var e = AutomationElement.FromPoint(new System.Windows.Point(a.Num("x"), a.Num("y")));
                    return e != null && e.Current.IsPassword;
                }
                if (a.Bool("focused"))
                {
                    var e = AutomationElement.FocusedElement;
                    return e != null && e.Current.IsPassword;
                }
            }
            catch (Exception ex) { Log.Write("uia isSecure: " + ex.Message); }
            return false;
        }

        /// <summary>The element a person would point at under (x, y) in window hwnd (point mode): down the ControlView to
        /// the deepest child under the point (FromPoint would hit VisionCLI's own overlay), then up from bare text and tiny
        /// bits to the link, button or card. Its frame and what it is ("button “Save” #save .btn"), or null.</summary>
        public static Dictionary<string, object> ElementAt(IntPtr hwnd, double x, double y)
        {
            var cache = Cache();
            cache.Add(AutomationElement.LocalizedControlTypeProperty);
            cache.Add(AutomationElement.ClassNameProperty);
            cache.Add(AutomationElement.FrameworkIdProperty);
            var walker = TreeWalker.ControlViewWalker;
            var pt = new System.Windows.Point(x, y);
            var sw = Stopwatch.StartNew();
            System.Windows.Rect Frame(AutomationElement e) => Get(e, AutomationElement.BoundingRectangleProperty) is System.Windows.Rect r ? r : System.Windows.Rect.Empty;
            using (cache.Activate())
            {
                var win = AutomationElement.FromHandle(hwnd);
                var el = win;
                for (int depth = 0; depth < MaxDepth && sw.ElapsedMilliseconds < 300; depth++)
                {
                    AutomationElement hit = null;
                    for (var c = walker.GetFirstChild(el, cache); c != null && sw.ElapsedMilliseconds < 300; c = walker.GetNextSibling(c, cache))
                        if (!Flag(c, AutomationElement.IsOffscreenProperty) && Frame(c).Contains(pt)) hit = c; // later siblings are on top
                    if (hit == null) break;
                    el = hit;
                }
                for (int i = 0; i < 6; i++)
                {
                    var r = Frame(el);
                    if (!Context.Contains(Role(el)) && r.Width >= 24 && r.Height >= 16) break;
                    var parent = walker.GetParent(el, cache);
                    if (parent == null) break;
                    el = parent;
                }
                var f = Frame(el);
                f.Intersect(Frame(win));
                if (f.IsEmpty || f.Width < 1 || f.Height < 1) return null;
                return Json.O("x", (int)Math.Round(f.X), "y", (int)Math.Round(f.Y), "w", (int)Math.Round(f.Width), "h", (int)Math.Round(f.Height), "about", Describe(el, walker, cache));
            }
        }

        /// <summary>What the assistant needs to find it in code: kind, visible text, and on web pages the DOM id and classes.</summary>
        static string Describe(AutomationElement e, TreeWalker walker, CacheRequest cache)
        {
            var parts = new List<string> { Clean(Text(e, AutomationElement.LocalizedControlTypeProperty)) is var kind && kind != "" ? kind : "element" };
            bool secure = Flag(e, AutomationElement.IsPasswordProperty);
            string t = Clean(Text(e, AutomationElement.NameProperty), 80);
            if (t == "") t = Clean(Text(e, AutomationElement.HelpTextProperty), 80);
            if (t == "" && !secure && Editable.Contains(Role(e))) t = Clean(Text(e, ValuePattern.ValueProperty), 80);
            if (t == "" && !secure) t = InnerText(e, walker, cache);
            if (t != "") parts.Add("“" + t + "”");
            // Chromium maps the DOM id to AutomationId and the class attribute to ClassName; native ones are noise.
            if (Text(e, AutomationElement.FrameworkIdProperty) == "Chrome")
            {
                var id = Text(e, AutomationElement.AutomationIdProperty).Trim();
                if (id != "") parts.Add("#" + id);
                var classes = Text(e, AutomationElement.ClassNameProperty).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (classes.Length > 0) parts.Add(string.Concat(classes.Take(4).Select(c => "." + c)));
            }
            return string.Join(" ", parts);
        }

        /// <summary>A web group or card has no name of its own: the start of the text inside it.</summary>
        static string InnerText(AutomationElement root, TreeWalker walker, CacheRequest cache)
        {
            var sb = new StringBuilder();
            int budget = 40;
            void Go(AutomationElement e, int depth)
            {
                if (sb.Length >= 80 || budget <= 0 || depth >= 4) return;
                budget--;
                if (Flag(e, AutomationElement.IsPasswordProperty)) return;
                if (depth > 0 && Role(e) == "Text") { var s = Text(e, AutomationElement.NameProperty).Trim(); if (s != "") sb.Append(sb.Length > 0 ? " " : "").Append(s); }
                for (var c = walker.GetFirstChild(e, cache); c != null && sb.Length < 80 && budget > 0; c = walker.GetNextSibling(c, cache)) Go(c, depth + 1);
            }
            try { Go(root, 0); } catch { }
            return Clean(sb.ToString(), 80);
        }

        static readonly HashSet<string> NameIsText = new HashSet<string> { "Text", "Hyperlink", "ListItem", "TreeItem", "DataItem", "HeaderItem" };

        /// <summary>Visible text of the front window, never from password fields: TextPattern ranges (whole documents,
        /// which cover their children), else values of edits, else names of text-like elements.</summary>
        public static Dictionary<string, object> WindowText(int max, int excludePid)
        {
            var t = Target(null, excludePid);
            if (t == null) return null;
            var cache = Cache();
            AutomationElement root;
            using (cache.Activate()) root = AutomationElement.FromHandle(t.Hwnd);
            var sb = new StringBuilder();
            var seen = new HashSet<string>();
            Walk(root, cache, n =>
            {
                if (sb.Length >= max) return Next.Stop;
                if (Flag(n, AutomationElement.IsPasswordProperty)) return Next.Skip;
                string role = Role(n);
                string text = null;
                bool fromPattern = false;
                if (Flag(n, AutomationElement.IsTextPatternAvailableProperty) && n.TryGetCurrentPattern(TextPattern.Pattern, out var tp))
                {
                    try { text = ((TextPattern)tp).DocumentRange.GetText(Math.Max(1, max - sb.Length)); fromPattern = !string.IsNullOrWhiteSpace(text); } catch { }
                }
                if (string.IsNullOrWhiteSpace(text) && Editable.Contains(role)) text = Text(n, ValuePattern.ValueProperty);
                if (string.IsNullOrWhiteSpace(text) && NameIsText.Contains(role)) text = Text(n, AutomationElement.NameProperty);
                if (string.IsNullOrWhiteSpace(text)) return fromPattern ? Next.Skip : Next.Descend;
                text = Regex.Replace(text.Replace("\uFFFC", ""), @"[ \t]+", " ").Trim();
                if (text.Length == 0 || !seen.Add(text)) return fromPattern ? Next.Skip : Next.Descend;
                if (sb.Length > 0) sb.Append('\n');
                sb.Append(text);
                return fromPattern ? Next.Skip : Next.Descend;
            });
            var all = sb.ToString();
            return Json.O("app", t.App, "title", t.Title, "text", all.Length > max ? all.Substring(0, max) : all);
        }
    }
}
