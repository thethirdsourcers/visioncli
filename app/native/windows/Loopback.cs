using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace VcliWin
{
    // What the speakers play (Listen to Calls): WASAPI loopback on the default output, downmixed and resampled to
    // 16 kHz mono 16-bit, streamed to the app as `loopback` events (~10 a second, base64 PCM). winmm has no loopback,
    // so this is the one place the helper uses the MMDevice/WASAPI COM interfaces.
    static class Loopback
    {
        public static Action<byte[]> OnPcm = b => { };

        const int ChunkBytes = Audio.Rate / 10 * 2;            // ~100 ms per event
        const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        const int CLSCTX_ALL = 23;

        static readonly object gate = new object();
        static Thread thread;
        static volatile bool stopping;

        public static bool Start()
        {
            lock (gate)
            {
                StopNow();
                stopping = false;
                var ready = new ManualResetEvent(false);
                Exception failed = null;
                // COM objects live on their own MTA thread for the whole capture.
                var t = new Thread(() => Run(ready, e => failed = e)) { IsBackground = true, Name = "loopback" };
                t.SetApartmentState(ApartmentState.MTA);
                t.Start();
                if (!ready.WaitOne(5000)) { stopping = true; throw new InvalidOperationException("the audio output didn't start"); }
                if (failed != null) throw new InvalidOperationException("Couldn't listen to the speakers: " + failed.Message);
                thread = t;
                return true;
            }
        }

        public static bool Stop() { lock (gate) StopNow(); return true; }

        static void StopNow()
        {
            stopping = true;
            thread?.Join(1000);
            thread = null;
        }

        static void Run(ManualResetEvent ready, Action<Exception> fail)
        {
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            try
            {
                var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
                Check(enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 1 /* eMultimedia */, out IMMDevice device), "no audio output");
                var iid = typeof(IAudioClient).GUID;
                Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out object o), "activate");
                client = (IAudioClient)o;
                Check(client.GetMixFormat(out IntPtr fmt), "mix format");
                var f = MixFormat.Read(fmt);
                try { Check(client.Initialize(0 /* shared */, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, IntPtr.Zero), "initialize"); }
                finally { Marshal.FreeCoTaskMem(fmt); }
                var ciid = typeof(IAudioCaptureClient).GUID;
                Check(client.GetService(ref ciid, out object c), "capture client");
                capture = (IAudioCaptureClient)c;
                Check(client.Start(), "start");
                ready.Set();
                Pump(capture, f);
            }
            catch (Exception e) { fail(e); ready.Set(); }
            finally
            {
                try { client?.Stop(); } catch { }
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
            }
        }

        static void Pump(IAudioCaptureClient capture, MixFormat f)
        {
            var rs = new Resampler(f.Rate);
            var outBuf = new byte[ChunkBytes];
            int outLen = 0;
            long produced = 0;
            var clock = Stopwatch.StartNew();
            Action<short> put = s =>
            {
                outBuf[outLen++] = (byte)s; outBuf[outLen++] = (byte)(s >> 8);
                produced++;
                if (outLen == ChunkBytes) { OnPcm((byte[])outBuf.Clone()); outLen = 0; }
            };
            while (!stopping)
            {
                Thread.Sleep(10);
                while (capture.GetNextPacketSize(out uint packet) == 0 && packet > 0)
                {
                    if (capture.GetBuffer(out IntPtr data, out uint frames, out uint flags, out _, out _) != 0) break;
                    bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                    for (int i = 0; i < frames; i++) rs.Push(silent ? 0f : f.Frame(data, i), put);
                    capture.ReleaseBuffer(frames);
                }
                // Loopback delivers nothing while nothing plays: fill the gap with silence, so the app sees the pause
                // that ends an utterance. Only when we're >100 ms behind real time, so real audio isn't padded.
                long due = clock.ElapsedMilliseconds * Audio.Rate / 1000;
                if (due - produced > Audio.Rate / 10) while (produced < due) put(0);
            }
        }

        static void Check(int hr, string what) { if (hr != 0) throw new InvalidOperationException(what + " (0x" + hr.ToString("X8") + ")"); }

        // The shared-mode mix format: usually 32-bit float, sometimes 16/24/32-bit integer PCM.
        sealed class MixFormat
        {
            public int Rate, Channels, Bits, BlockAlign;
            public bool Float;

            public static MixFormat Read(IntPtr p)
            {
                var m = new MixFormat
                {
                    Channels = Marshal.ReadInt16(p, 2), Rate = Marshal.ReadInt32(p, 4),
                    BlockAlign = Marshal.ReadInt16(p, 12), Bits = Marshal.ReadInt16(p, 14),
                };
                int tag = (ushort)Marshal.ReadInt16(p, 0);
                if (tag == 0xFFFE) // WAVE_FORMAT_EXTENSIBLE: the SubFormat GUID's first field is the format tag
                    tag = Marshal.ReadInt32(p, 24);
                m.Float = tag == 3;
                return m;
            }

            /// One frame downmixed to mono, −1…1.
            public float Frame(IntPtr data, int i)
            {
                int off = i * BlockAlign, step = Bits / 8;
                float sum = 0;
                for (int ch = 0; ch < Channels; ch++, off += step)
                {
                    if (Float && Bits == 32) sum += BitConverter.ToSingle(BitConverter.GetBytes(Marshal.ReadInt32(data, off)), 0);
                    else if (Bits == 16) sum += Marshal.ReadInt16(data, off) / 32768f;
                    else if (Bits == 24) sum += ((Marshal.ReadByte(data, off) | Marshal.ReadByte(data, off + 1) << 8 | (sbyte)Marshal.ReadByte(data, off + 2) << 16)) / 8388608f;
                    else if (Bits == 32) sum += Marshal.ReadInt32(data, off) / 2147483648f;
                }
                return Channels > 0 ? sum / Channels : 0;
            }
        }

        // Averages the input samples falling into each 16 kHz output sample (a box filter): enough for speech.
        sealed class Resampler
        {
            readonly double ratio;
            double phase, acc;
            int n;
            public Resampler(int rate) { ratio = rate / (double)Audio.Rate; }

            public void Push(float s, Action<short> put)
            {
                acc += s; n++; phase += 1;
                if (phase < ratio) return;
                phase -= ratio;
                double v = Math.Max(-1, Math.Min(1, acc / n));
                put((short)(v * 32767));
                acc = 0; n = 0;
            }
        }

        // ── COM interfaces (only the methods used are called; the vtable order must match) ──

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        }

        [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioClient
        {
            [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
            [PreserveSig] int GetBufferSize(out uint frames);
            [PreserveSig] int GetStreamLatency(out long latency);
            [PreserveSig] int GetCurrentPadding(out uint frames);
            [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
            [PreserveSig] int GetMixFormat(out IntPtr format);
            [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
            [PreserveSig] int Start();
            [PreserveSig] int Stop();
            [PreserveSig] int Reset();
            [PreserveSig] int SetEventHandle(IntPtr handle);
            [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        }

        [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioCaptureClient
        {
            [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
            [PreserveSig] int ReleaseBuffer(uint frames);
            [PreserveSig] int GetNextPacketSize(out uint frames);
        }
    }
}
