using System;
using System.Runtime.InteropServices;
using System.Threading;
using static VcliWin.Native;

namespace VcliWin
{
    // The microphone as a live stream (Meeting Notes): its own waveIn, separate from Audio's hold-to-talk recording,
    // so both can run at once. ~100 ms of 16 kHz mono 16-bit PCM per `mic` event.
    static class MicStream
    {
        public static Action<byte[]> OnPcm = b => { };

        const int BufferBytes = Audio.Rate / 10 * 2;
        const int Buffers = 8;

        static readonly object gate = new object();
        static IntPtr handle, ev;
        static IntPtr[] headers;
        static Thread thread;
        static volatile bool stopping;
        static int next;

        public static bool Start(string device)
        {
            lock (gate)
            {
                StopNow();
                ev = CreateEvent(IntPtr.Zero, false, false, null);
                int err = waveInOpen(out handle, Audio.DeviceIndex(device), Audio.Format(Audio.Rate, 1, 16), ev, IntPtr.Zero, CALLBACK_EVENT);
                if (err != 0)
                {
                    CloseHandle(ev);
                    ev = IntPtr.Zero;
                    handle = IntPtr.Zero;
                    throw new InvalidOperationException("waveInOpen failed (MMRESULT " + err + "): no microphone, or microphone access is off in Privacy settings");
                }
                headers = new IntPtr[Buffers];
                for (int i = 0; i < Buffers; i++)
                {
                    var h = Marshal.AllocHGlobal(Audio.HdrSize);
                    var hdr = new WAVEHDR { lpData = Marshal.AllocHGlobal(BufferBytes), dwBufferLength = BufferBytes };
                    Marshal.StructureToPtr(hdr, h, false);
                    waveInPrepareHeader(handle, h, Audio.HdrSize);
                    waveInAddBuffer(handle, h, Audio.HdrSize);
                    headers[i] = h;
                }
                next = 0;
                stopping = false;
                err = waveInStart(handle);
                if (err != 0) { StopNow(); throw new InvalidOperationException("waveInStart failed (MMRESULT " + err + ")"); }
                var hnd = handle;
                thread = new Thread(() => Loop(hnd)) { IsBackground = true, Name = "micstream" };
                thread.Start();
                return true;
            }
        }

        // Hands each finished buffer to the app, in order, and gives it back to the driver.
        static void Loop(IntPtr hnd)
        {
            var buf = new byte[BufferBytes];
            while (!stopping)
            {
                WaitForSingleObject(ev, 100);
                while (!stopping)
                {
                    var h = headers[next];
                    var hdr = Marshal.PtrToStructure<WAVEHDR>(h);
                    if ((hdr.dwFlags & WHDR_DONE) == 0) break;
                    int n = (int)hdr.dwBytesRecorded;
                    if (n > 0)
                    {
                        var chunk = new byte[n];
                        Marshal.Copy(hdr.lpData, chunk, 0, n);
                        try { OnPcm(chunk); } catch { }
                    }
                    hdr.dwFlags &= ~WHDR_DONE;
                    hdr.dwBytesRecorded = 0;
                    Marshal.StructureToPtr(hdr, h, false);
                    waveInAddBuffer(hnd, h, Audio.HdrSize);
                    next = (next + 1) % Buffers;
                }
            }
        }

        static void StopNow()
        {
            if (handle == IntPtr.Zero) return;
            stopping = true;
            thread?.Join(1000);
            thread = null;
            waveInReset(handle);
            if (headers != null)
                foreach (var h in headers)
                {
                    if (h == IntPtr.Zero) continue;
                    var hdr = Marshal.PtrToStructure<WAVEHDR>(h);
                    waveInUnprepareHeader(handle, h, Audio.HdrSize);
                    Marshal.FreeHGlobal(hdr.lpData);
                    Marshal.FreeHGlobal(h);
                }
            headers = null;
            waveInClose(handle);
            CloseHandle(ev);
            handle = IntPtr.Zero;
            ev = IntPtr.Zero;
        }

        public static bool Stop() { lock (gate) StopNow(); return true; }
    }
}
