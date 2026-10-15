using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using static VcliWin.Native;

namespace VcliWin
{
    // waveIn / waveOut (winmm): present on every Windows, no COM, works for normal users.
    // Device ids are waveIn/waveOut indices as strings; "default" or null is WAVE_MAPPER (follows the system default).
    // Limitation: winmm device names are cut at 31 characters (MAXPNAMELEN) — the full endpoint names need MMDevice COM.
    static class Audio
    {
        public const int Rate = 16000;
        internal static readonly int HdrSize = Marshal.SizeOf<WAVEHDR>();

        internal static byte[] Format(int rate, short channels, short bits) // WAVEFORMATEX, PCM
        {
            var b = new byte[18];
            using (var w = new BinaryWriter(new MemoryStream(b)))
            {
                w.Write((short)1); w.Write(channels); w.Write(rate);
                w.Write(rate * channels * bits / 8); w.Write((short)(channels * bits / 8)); w.Write(bits); w.Write((short)0);
            }
            return b;
        }

        internal static int DeviceIndex(string id)
        {
            if (string.IsNullOrEmpty(id) || id == "default") return WAVE_MAPPER;
            if (int.TryParse(id, out int i)) return i;
            throw new ArgumentException("unknown audio device '" + id + "'");
        }

        public static Dictionary<string, object> Devices()
        {
            var inputs = new List<object>();
            int defIn = -1, defOut = -1;
            // The device the mapper uses (the user's default), when the driver tells.
            try { if (waveInMessage(new IntPtr(WAVE_MAPPER), DRVM_MAPPER_PREFERRED_GET, out int d, out _) == 0) defIn = d; } catch { }
            try { if (waveOutMessage(new IntPtr(WAVE_MAPPER), DRVM_MAPPER_PREFERRED_GET, out int d, out _) == 0) defOut = d; } catch { }
            int n = waveInGetNumDevs();
            for (int i = 0; i < n; i++)
            {
                var caps = new WAVEINCAPS();
                if (waveInGetDevCaps(new IntPtr(i), ref caps, Marshal.SizeOf<WAVEINCAPS>()) != 0) continue;
                inputs.Add(Json.O("id", i.ToString(), "name", caps.szPname ?? ("Input " + i), "isDefault", defIn >= 0 ? i == defIn : i == 0));
            }
            var outputs = new List<object>();
            n = waveOutGetNumDevs();
            for (int i = 0; i < n; i++)
            {
                var caps = new WAVEOUTCAPS();
                if (waveOutGetDevCaps(new IntPtr(i), ref caps, Marshal.SizeOf<WAVEOUTCAPS>()) != 0) continue;
                outputs.Add(Json.O("id", i.ToString(), "name", caps.szPname ?? ("Output " + i), "isDefault", defOut >= 0 ? i == defOut : i == 0));
            }
            return Json.O("inputs", inputs, "outputs", outputs);
        }

        public static byte[] Wav(byte[] pcm, int length, int rate = Rate, short channels = 1, short bits = 16)
        {
            var ms = new MemoryStream(44 + length);
            using (var w = new BinaryWriter(ms, Encoding.ASCII, true))
            {
                w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + length); w.Write(Encoding.ASCII.GetBytes("WAVE"));
                w.Write(Encoding.ASCII.GetBytes("fmt ")); w.Write(16);
                w.Write((short)1); w.Write(channels); w.Write(rate); w.Write(rate * channels * bits / 8);
                w.Write((short)(channels * bits / 8)); w.Write(bits);
                w.Write(Encoding.ASCII.GetBytes("data")); w.Write(length);
                w.Write(pcm, 0, length);
            }
            return ms.ToArray();
        }

        static void WriteAtomic(string file, byte[] bytes)
        {
            var dir = Path.GetDirectoryName(file);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            string tmp = file + ".tmp";
            File.WriteAllBytes(tmp, bytes);
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
        }

        /// <summary>0…1 like the macOS meter: RMS × 12 of samples in −1…1.</summary>
        public static double Level(byte[] pcm, int offset, int count)
        {
            int n = count / 2;
            if (n == 0) return 0;
            double sum = 0;
            for (int i = 0; i < n; i++)
            {
                double s = BitConverter.ToInt16(pcm, offset + i * 2) / 32768.0;
                sum += s * s;
            }
            return Math.Min(1, Math.Sqrt(sum / n) * 12);
        }

        // ── Recording ──

        sealed class Recording
        {
            public IntPtr Handle, Event;
            public IntPtr[] Headers;
            public string File;
            public readonly MemoryStream Pcm = new MemoryStream();
            public volatile bool Stopping;
            public int Next; // the header the driver fills next
            public Thread Thread;
        }

        static readonly object recGate = new object();
        static Recording rec;
        public static Action<double> OnLevel = l => { };

        // ~30 buffers a second, each one a level update.
        const int BufferBytes = Rate / 30 * 2;
        const int Buffers = 16;

        public static bool Start(string file, string device)
        {
            lock (recGate)
            {
                if (rec != null) StopNow(false);
                var r = new Recording { File = file, Event = CreateEvent(IntPtr.Zero, false, false, null) };
                int err = waveInOpen(out r.Handle, DeviceIndex(device), Format(Rate, 1, 16), r.Event, IntPtr.Zero, CALLBACK_EVENT);
                if (err != 0) { CloseHandle(r.Event); throw new InvalidOperationException("waveInOpen failed (MMRESULT " + err + "): no microphone, or microphone access is off in Privacy settings"); }
                r.Headers = new IntPtr[Buffers];
                for (int i = 0; i < Buffers; i++)
                {
                    var h = Marshal.AllocHGlobal(HdrSize);
                    var hdr = new WAVEHDR { lpData = Marshal.AllocHGlobal(BufferBytes), dwBufferLength = BufferBytes };
                    Marshal.StructureToPtr(hdr, h, false);
                    waveInPrepareHeader(r.Handle, h, HdrSize);
                    waveInAddBuffer(r.Handle, h, HdrSize);
                    r.Headers[i] = h;
                }
                err = waveInStart(r.Handle);
                if (err != 0) { Release(r); throw new InvalidOperationException("waveInStart failed (MMRESULT " + err + ")"); }
                r.Thread = new Thread(() => Loop(r)) { IsBackground = true, Name = "waveIn" };
                rec = r;
                r.Thread.Start();
                return true;
            }
        }

        // Collects finished buffers in order and hands them back to the driver.
        static void Loop(Recording r)
        {
            var buf = new byte[BufferBytes];
            while (!r.Stopping)
            {
                WaitForSingleObject(r.Event, 100);
                while (!r.Stopping && Collect(r, buf, true)) { }
            }
        }

        static bool Collect(Recording r, byte[] buf, bool requeue)
        {
            var h = r.Headers[r.Next];
            var hdr = Marshal.PtrToStructure<WAVEHDR>(h);
            if ((hdr.dwFlags & WHDR_DONE) == 0) return false;
            int n = (int)hdr.dwBytesRecorded;
            if (n > 0)
            {
                Marshal.Copy(hdr.lpData, buf, 0, n);
                lock (r.Pcm) r.Pcm.Write(buf, 0, n);
                if (requeue) try { OnLevel(Level(buf, 0, n)); } catch { }
            }
            hdr.dwFlags &= ~WHDR_DONE;
            hdr.dwBytesRecorded = 0;
            Marshal.StructureToPtr(hdr, h, false);
            if (requeue) waveInAddBuffer(r.Handle, h, HdrSize);
            r.Next = (r.Next + 1) % Buffers;
            return true;
        }

        static void Release(Recording r)
        {
            r.Stopping = true;
            r.Thread?.Join(1000);
            waveInReset(r.Handle); // marks every queued buffer done, the partly filled one with what it has
            // What was recorded but not collected yet (in order) still counts.
            if (r.Headers != null)
            {
                var buf = new byte[BufferBytes];
                for (int i = 0; i < Buffers && Collect(r, buf, false); i++) { }
            }
            if (r.Headers != null)
                foreach (var h in r.Headers)
                {
                    if (h == IntPtr.Zero) continue;
                    var hdr = Marshal.PtrToStructure<WAVEHDR>(h);
                    waveInUnprepareHeader(r.Handle, h, HdrSize);
                    Marshal.FreeHGlobal(hdr.lpData);
                    Marshal.FreeHGlobal(h);
                }
            waveInClose(r.Handle);
            CloseHandle(r.Event);
        }

        static Dictionary<string, object> StopNow(bool save)
        {
            var r = rec;
            rec = null;
            if (r == null) return null;
            Release(r);
            byte[] pcm;
            lock (r.Pcm) pcm = r.Pcm.ToArray();
            if (save) WriteAtomic(r.File, Wav(pcm, pcm.Length));
            return Json.O("file", r.File, "seconds", pcm.Length / 2.0 / Rate);
        }

        public static Dictionary<string, object> Stop()
        {
            lock (recGate) return StopNow(true) ?? throw new InvalidOperationException("not recording");
        }

        public static bool Cancel() { lock (recGate) StopNow(false); return true; }

        public static bool Snapshot(string file)
        {
            var r = rec;
            if (r == null) return false;
            byte[] pcm;
            lock (r.Pcm) pcm = r.Pcm.ToArray();
            WriteAtomic(file, Wav(pcm, pcm.Length));
            return true;
        }

        // ── Playback ──

        static readonly ConcurrentDictionary<string, IntPtr> playing = new ConcurrentDictionary<string, IntPtr>();
        static readonly ConcurrentDictionary<string, bool> stopped = new ConcurrentDictionary<string, bool>();

        /// <summary>The fmt chunk as-is (PCM, float or extensible: waveOut takes the WAVEFORMATEX(TENSIBLE) bytes) and the data.</summary>
        public static void ParseWav(byte[] b, out byte[] fmt, out int dataOffset, out int dataLength)
        {
            if (b.Length < 12 || Encoding.ASCII.GetString(b, 0, 4) != "RIFF" || Encoding.ASCII.GetString(b, 8, 4) != "WAVE")
                throw new InvalidDataException("not a WAV file");
            fmt = null; dataOffset = -1; dataLength = 0;
            int p = 12;
            while (p + 8 <= b.Length)
            {
                string id = Encoding.ASCII.GetString(b, p, 4);
                int len = BitConverter.ToInt32(b, p + 4);
                int body = p + 8;
                if (id == "fmt ")
                {
                    fmt = new byte[Math.Max(18, len)];
                    Array.Copy(b, body, fmt, 0, Math.Min(len, b.Length - body));
                    if (len < 18) { fmt[16] = 0; fmt[17] = 0; } // cbSize = 0
                }
                else if (id == "data")
                {
                    dataOffset = body;
                    // Streams written before their length was known say 0 or 0xFFFFFFFF: take the rest of the file.
                    dataLength = len <= 0 || body + len > b.Length ? b.Length - body : len;
                    break;
                }
                p = body + len + (len & 1);
            }
            if (fmt == null || dataOffset < 0) throw new InvalidDataException("WAV without fmt/data");
        }

        public static bool Play(string file, string device, string token)
        {
            var bytes = File.ReadAllBytes(file);
            ParseWav(bytes, out var fmt, out int off, out int len);
            int align = Math.Max(1, (int)BitConverter.ToInt16(fmt, 12));
            len -= len % align;
            if (len <= 0) return true;
            // A play.stop can arrive before its play (requests run concurrently), so a token's stop is kept until
            // that play ends.
            if (stopped.Count > 1000) stopped.Clear();
            IntPtr ev = CreateEvent(IntPtr.Zero, false, false, null);
            int err = waveOutOpen(out IntPtr h, DeviceIndex(device), fmt, ev, IntPtr.Zero, CALLBACK_EVENT);
            if (err != 0) { CloseHandle(ev); throw new InvalidOperationException("waveOutOpen failed (MMRESULT " + err + ")"); }
            IntPtr data = Marshal.AllocHGlobal(len), hdrPtr = Marshal.AllocHGlobal(HdrSize);
            try
            {
                if (token != null) playing[token] = h;
                Marshal.Copy(bytes, off, data, len);
                Marshal.StructureToPtr(new WAVEHDR { lpData = data, dwBufferLength = (uint)len }, hdrPtr, false);
                waveOutPrepareHeader(h, hdrPtr, HdrSize);
                if (token != null && stopped.ContainsKey(token)) return true; // stopped before it started
                waveOutWrite(h, hdrPtr, HdrSize);
                while ((Marshal.PtrToStructure<WAVEHDR>(hdrPtr).dwFlags & WHDR_DONE) == 0)
                {
                    WaitForSingleObject(ev, 200);
                    if (token != null && stopped.ContainsKey(token)) { waveOutReset(h); break; }
                }
                return true;
            }
            finally
            {
                if (token != null) { playing.TryRemove(token, out _); stopped.TryRemove(token, out _); }
                waveOutReset(h);
                waveOutUnprepareHeader(h, hdrPtr, HdrSize);
                waveOutClose(h);
                CloseHandle(ev);
                Marshal.FreeHGlobal(data);
                Marshal.FreeHGlobal(hdrPtr);
            }
        }

        public static bool StopPlay(string token)
        {
            if (string.IsNullOrEmpty(token)) return true;
            stopped[token] = true;
            if (playing.TryGetValue(token, out var h)) waveOutReset(h); // wakes the player, which returns
            return true;
        }
    }
}
