// AuroraSpectrum - WASAPI loopback real-time spectrum analyzer.
// Emits one JSON line per frame (~30 fps) to stdout; diagnostics to stderr.
// No third-party libraries: .NET Framework 4.x + COM interop only.

using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AuroraSpectrum
{
    internal static class Program
    {
        [MTAThread]
        private static void Main()
        {
            var state = new SpectrumState();
            var analyzer = new Analyzer(state);

            var thread = new Thread(analyzer.Run);
            thread.IsBackground = true;
            thread.Name = "SpectrumAnalyzer";
            thread.Priority = ThreadPriority.AboveNormal;
            thread.Start();

            new CaptureEngine(state).RunForever();
        }
    }

    // ---------------------------------------------------------------------
    // Shared state: mono sample ring buffer written by the capture thread and
    // read by the analysis thread.
    // ---------------------------------------------------------------------
    internal sealed class SpectrumState
    {
        private const int RingSize = 1 << 16; // ~1.36 s at 48 kHz

        private readonly object sync = new object();
        private readonly float[] ring = new float[RingSize];
        private int writePos;
        private long totalSamples;
        private long lastPacketTimestamp;
        private int sampleRate = 48000;
        private int channels = 2;

        public int SampleRate
        {
            get { return sampleRate; }
        }

        public int Channels
        {
            get { return channels; }
        }

        public void Reset(int rate, int ch)
        {
            lock (sync)
            {
                sampleRate = rate;
                channels = ch;
                writePos = 0;
                totalSamples = 0;
                lastPacketTimestamp = Stopwatch.GetTimestamp();
                Array.Clear(ring, 0, ring.Length);
            }
        }

        public void Append(float[] mono, int count)
        {
            if (count <= 0)
            {
                return;
            }

            lock (sync)
            {
                int pos = writePos;
                for (int i = 0; i < count; i++)
                {
                    ring[pos] = mono[i];
                    pos++;
                    if (pos == RingSize)
                    {
                        pos = 0;
                    }
                }

                writePos = pos;
                totalSamples += count;
                lastPacketTimestamp = Stopwatch.GetTimestamp();
            }
        }

        // Fills dest with the newest dest.Length samples. If the last packet is
        // older than maxAgeTicks, the window is filled with silence so the
        // analyser decays to zero even when no packets are delivered at all.
        public void FillLatest(float[] dest, long maxAgeTicks)
        {
            lock (sync)
            {
                bool stale = (Stopwatch.GetTimestamp() - lastPacketTimestamp) > maxAgeTicks;
                int n = stale ? 0 : (int)Math.Min(totalSamples, (long)dest.Length);
                int pad = dest.Length - n;

                for (int i = 0; i < pad; i++)
                {
                    dest[i] = 0f;
                }

                int pos = writePos - n;
                if (pos < 0)
                {
                    pos += RingSize;
                }

                for (int i = 0; i < n; i++)
                {
                    dest[pad + i] = ring[pos];
                    pos++;
                    if (pos == RingSize)
                    {
                        pos = 0;
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Spectral analyser: Hann window, 1024-point radix-2 FFT, 16 log bands.
    // ---------------------------------------------------------------------
    internal sealed class Analyzer
    {
        private const int FftSize = 1024;
        private const int BandCount = 16;
        private const double LowHz = 40.0;
        private const double HighHz = 16000.0;
        private const double SilentRms = 0.001; // -60 dBFS

        private readonly SpectrumState state;

        private readonly float[] samples = new float[FftSize];
        private readonly double[] re = new double[FftSize];
        private readonly double[] im = new double[FftSize];
        private readonly double[] window = new double[FftSize];
        private readonly double[] amplitudes = new double[FftSize / 2 + 1];
        private readonly double[] bandEdges = new double[BandCount + 1];
        private readonly double[] bandLevels = new double[BandCount];
        private readonly int[] bitRev = new int[FftSize];
        private readonly double[] cosTable = new double[FftSize / 2];
        private readonly double[] sinTable = new double[FftSize / 2];
        private readonly double windowSum;
        private readonly StringBuilder json = new StringBuilder(192);

        private double peakLevel;
        private long maxAgeTicks;

        public Analyzer(SpectrumState state)
        {
            this.state = state;
            maxAgeTicks = Stopwatch.Frequency / 4; // 250 ms

            for (int i = 0; i < FftSize; i++)
            {
                window[i] = 0.5 * (1.0 - Math.Cos(2.0 * Math.PI * i / (FftSize - 1)));
            }

            double sum = 0.0;
            for (int i = 0; i < FftSize; i++)
            {
                sum += window[i];
            }
            windowSum = sum;

            int bits = 0;
            while ((1 << bits) < FftSize)
            {
                bits++;
            }

            for (int i = 0; i < FftSize; i++)
            {
                int r = 0;
                for (int b = 0; b < bits; b++)
                {
                    if ((i & (1 << b)) != 0)
                    {
                        r |= 1 << (bits - 1 - b);
                    }
                }
                bitRev[i] = r;
            }

            for (int k = 0; k < FftSize / 2; k++)
            {
                cosTable[k] = Math.Cos(2.0 * Math.PI * k / FftSize);
                sinTable[k] = -Math.Sin(2.0 * Math.PI * k / FftSize);
            }

            for (int b = 0; b <= BandCount; b++)
            {
                bandEdges[b] = LowHz * Math.Pow(HighHz / LowHz, (double)b / BandCount);
            }
        }

        public void Run()
        {
            var sw = Stopwatch.StartNew();
            double nextMs = 0.0;

            while (true)
            {
                nextMs += 1000.0 / 30.0;
                double nowMs = sw.Elapsed.TotalMilliseconds;
                double delay = nextMs - nowMs;

                if (delay > 0.0)
                {
                    int sleep = (int)Math.Floor(delay);
                    if (sleep > 0)
                    {
                        Thread.Sleep(sleep);
                    }
                }
                else if (delay < -200.0)
                {
                    nextMs = nowMs; // resynchronise after a long stall
                }

                try
                {
                    AnalyzeAndEmit();
                }
                catch (Exception ex)
                {
                    Logger.Write("analyzer error: " + ex.GetType().Name + ": " + ex.Message);
                }
            }
        }

        private void AnalyzeAndEmit()
        {
            state.FillLatest(samples, maxAgeTicks);

            double sum = 0.0;
            double sumSq = 0.0;
            double peakAbs = 0.0;
            for (int i = 0; i < FftSize; i++)
            {
                float v = samples[i];
                sum += v;
                sumSq += (double)v * v;
                double a = Math.Abs(v);
                if (a > peakAbs)
                {
                    peakAbs = a;
                }
            }

            double mean = sum / FftSize;
            double rms = Math.Sqrt(sumSq / FftSize);

            for (int i = 0; i < FftSize; i++)
            {
                re[i] = (samples[i] - mean) * window[i];
                im[i] = 0.0;
            }

            Fft();

            double norm = 2.0 / windowSum;
            for (int k = 0; k <= FftSize / 2; k++)
            {
                amplitudes[k] = Math.Sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
            }

            int rate = state.SampleRate;
            if (rate <= 0)
            {
                rate = 48000;
            }

            double binHz = (double)rate / FftSize;
            int maxBin = FftSize / 2;

            for (int b = 0; b < BandCount; b++)
            {
                double lo = bandEdges[b];
                double hi = bandEdges[b + 1];
                int k0 = (int)Math.Ceiling(lo / binHz);
                int k1 = (int)Math.Floor(hi / binHz);

                if (k0 < 1)
                {
                    k0 = 1;
                }
                if (k1 > maxBin)
                {
                    k1 = maxBin;
                }

                double amp;
                if (k1 >= k0)
                {
                    // Band energy (RMS amplitude of the bin set); a full-scale
                    // sine in one bin yields roughly 1.0 before smoothing.
                    double power = 0.0;
                    for (int k = k0; k <= k1; k++)
                    {
                        power += amplitudes[k] * amplitudes[k];
                    }
                    amp = Math.Sqrt(power);
                }
                else
                {
                    // Narrow low band without its own bin: interpolate.
                    double fc = Math.Sqrt(lo * hi);
                    double pos = fc / binHz;
                    int i0 = (int)Math.Floor(pos);
                    if (i0 < 1)
                    {
                        i0 = 1;
                    }
                    if (i0 >= maxBin)
                    {
                        i0 = maxBin - 1;
                    }
                    double frac = pos - i0;
                    amp = amplitudes[i0] * (1.0 - frac) + amplitudes[i0 + 1] * frac;
                }

                double db = 20.0 * Math.Log10(amp + 1e-9);
                double level = (db + 72.0) * (100.0 / 72.0);
                if (level < 0.0)
                {
                    level = 0.0;
                }
                else if (level > 100.0)
                {
                    level = 100.0;
                }

                double decayed = bandLevels[b] * 0.72;
                bandLevels[b] = level > decayed ? level : decayed;
            }

            double peakDb = 20.0 * Math.Log10(peakAbs + 1e-9);
            double peakNow = (peakDb + 60.0) * (100.0 / 60.0);
            if (peakNow < 0.0)
            {
                peakNow = 0.0;
            }
            else if (peakNow > 100.0)
            {
                peakNow = 100.0;
            }

            double peakDecayed = peakLevel * 0.85;
            peakLevel = peakNow > peakDecayed ? peakNow : peakDecayed;

            bool silent = rms < SilentRms;
            Emit(rms, silent);
        }

        private void Emit(double rms, bool silent)
        {
            json.Length = 0;
            json.Append("{\"bands\":[");
            for (int b = 0; b < BandCount; b++)
            {
                if (b > 0)
                {
                    json.Append(',');
                }
                json.Append((int)(bandLevels[b] + 0.5));
            }

            json.Append("],\"peak\":");
            json.Append((int)(peakLevel + 0.5));
            json.Append(",\"rms\":");
            json.Append(rms.ToString("0.0000", CultureInfo.InvariantCulture));
            json.Append(",\"silent\":");
            json.Append(silent ? "true" : "false");
            json.Append('}');

            try
            {
                Console.Out.WriteLine(json.ToString());
                Console.Out.Flush();
            }
            catch (System.IO.IOException)
            {
                // stdout consumer is gone: nothing left to do.
                Environment.Exit(0);
            }
        }

        private void Fft()
        {
            for (int i = 0; i < FftSize; i++)
            {
                int j = bitRev[i];
                if (j > i)
                {
                    double tr = re[i];
                    re[i] = re[j];
                    re[j] = tr;
                    double ti = im[i];
                    im[i] = im[j];
                    im[j] = ti;
                }
            }

            for (int len = 2; len <= FftSize; len <<= 1)
            {
                int half = len >> 1;
                int step = FftSize / len;

                for (int start = 0; start < FftSize; start += len)
                {
                    for (int j = 0; j < half; j++)
                    {
                        int tw = j * step;
                        double wr = cosTable[tw];
                        double wi = sinTable[tw];
                        int a = start + j;
                        int b = a + half;

                        double tr = re[b] * wr - im[b] * wi;
                        double ti = re[b] * wi + im[b] * wr;

                        re[b] = re[a] - tr;
                        im[b] = im[a] - ti;
                        re[a] += tr;
                        im[a] += ti;
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Capture supervisor: keeps a loopback session alive forever, rebuilding
    // it after device loss / default-device change.
    // ---------------------------------------------------------------------
    internal sealed class CaptureEngine
    {
        private readonly SpectrumState state;

        public CaptureEngine(SpectrumState state)
        {
            this.state = state;
        }

        public void RunForever()
        {
            while (true)
            {
                AudioSession session = null;
                try
                {
                    session = new AudioSession(state);
                    session.Initialize();
                    session.CaptureLoop();
                }
                catch (Exception ex)
                {
                    Logger.Write("capture error: " + ex.GetType().Name + ": " + ex.Message);
                }
                finally
                {
                    if (session != null)
                    {
                        session.Dispose();
                    }
                }

                Thread.Sleep(1500);
            }
        }
    }

    internal enum SampleKind
    {
        Float32,
        Pcm8,
        Pcm16,
        Pcm24,
        Pcm32
    }

    // ---------------------------------------------------------------------
    // One WASAPI loopback capture session (default render endpoint).
    // ---------------------------------------------------------------------
    internal sealed class AudioSession : IDisposable
    {
        private const int CLSCTX_ALL = 23;
        private const int AUDCLNT_SHAREMODE_SHARED = 0;
        private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002;
        private const ushort WAVE_FORMAT_PCM = 1;
        private const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        private const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
        private const int E_NOINTERFACE = unchecked((int)0x80004002);

        private static readonly Guid CLSID_MMDeviceEnumerator =
            new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");

        private static readonly Guid KSDATAFORMAT_SUBTYPE_PCM =
            new Guid("00000001-0000-0010-8000-00AA00389B71");

        private static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT =
            new Guid("00000003-0000-0010-8000-00AA00389B71");

        private readonly SpectrumState state;

        private IMMDeviceEnumerator enumerator;
        private IMMDevice device;
        private AudioClientFacade client;
        private IAudioCaptureClient capture;

        private string deviceId;
        private int sampleRate;
        private int channels;
        private int blockAlign;
        private int bytesPerSample;
        private int containerBits;
        private SampleKind kind;
        private long lastDeviceCheck;

        private float[] mono = new float[0];
        private byte[] raw = new byte[0];

        public AudioSession(SpectrumState state)
        {
            this.state = state;
        }

        public void Initialize()
        {
            object enumeratorObject = Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator));
            enumerator = (IMMDeviceEnumerator)enumeratorObject;

            Check(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out device),
                "GetDefaultAudioEndpoint");

            IntPtr idPtr;
            Check(device.GetId(out idPtr), "IMMDevice.GetId");
            try
            {
                deviceId = Marshal.PtrToStringUni(idPtr);
            }
            finally
            {
                Marshal.FreeCoTaskMem(idPtr);
            }

            Guid iid = typeof(IAudioClient).GUID;
            object clientObject = null;
            int activateHr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out clientObject);

            if (activateHr >= 0)
            {
                client = new AudioClientFacade((IAudioClient)clientObject);
            }
            else if (activateHr == E_NOINTERFACE)
            {
                // Some Windows builds expose only IAudioClient2/3 from the
                // audio engine and reject the base IID; its vtable starts with
                // the IAudioClient methods, so a dedicated v2 declaration works.
                Guid iid2 = typeof(IAudioClient2).GUID;
                object client2Object = null;
                Check(device.Activate(ref iid2, CLSCTX_ALL, IntPtr.Zero, out client2Object),
                    "IMMDevice.Activate(IAudioClient2)");
                client = new AudioClientFacade((IAudioClient2)client2Object);
            }
            else
            {
                Check(activateHr, "IMMDevice.Activate(IAudioClient)");
            }

            IntPtr formatPtr;
            Check(client.GetMixFormat(out formatPtr), "IAudioClient.GetMixFormat");
            try
            {
                ParseFormat(formatPtr);

                int hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                    10000000L, 0L, formatPtr, IntPtr.Zero);
                if (hr < 0)
                {
                    // Some drivers reject a 1 s shared buffer; fall back to the
                    // engine default (0).
                    hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                        0L, 0L, formatPtr, IntPtr.Zero);
                }
                Check(hr, "IAudioClient.Initialize(loopback)");
            }
            finally
            {
                Marshal.FreeCoTaskMem(formatPtr);
            }

            Guid captureIid = typeof(IAudioCaptureClient).GUID;
            object captureObject;
            Check(client.GetService(ref captureIid, out captureObject),
                "IAudioClient.GetService(IAudioCaptureClient)");
            capture = (IAudioCaptureClient)captureObject;

            Check(client.Start(), "IAudioClient.Start");

            state.Reset(sampleRate, channels);

            Logger.Write(string.Format(CultureInfo.InvariantCulture,
                "loopback started: device={0}, {1} ch, {2} Hz, {3}, {4}-bit container, blockAlign={5}, api={6}",
                ShortId(deviceId), channels, sampleRate, kind, containerBits, blockAlign,
                client.IsVersion2 ? "IAudioClient2" : "IAudioClient"));
        }

        public void CaptureLoop()
        {
            lastDeviceCheck = Stopwatch.GetTimestamp();
            long deviceCheckInterval = Stopwatch.Frequency * 2;

            while (true)
            {
                if ((Stopwatch.GetTimestamp() - lastDeviceCheck) > deviceCheckInterval)
                {
                    lastDeviceCheck = Stopwatch.GetTimestamp();
                    CheckDefaultDevice();
                }

                uint packetFrames;
                Check(capture.GetNextPacketSize(out packetFrames), "IAudioCaptureClient.GetNextPacketSize");

                if (packetFrames == 0)
                {
                    Thread.Sleep(4);
                    continue;
                }

                while (packetFrames > 0)
                {
                    IntPtr data;
                    uint frames;
                    uint flags;
                    ulong devicePosition;
                    ulong qpcPosition;

                    Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition),
                        "IAudioCaptureClient.GetBuffer");

                    if (frames > 0)
                    {
                        try
                        {
                            AppendPacket(data, (int)frames, flags);
                        }
                        finally
                        {
                            capture.ReleaseBuffer(frames);
                        }
                    }
                    else
                    {
                        capture.ReleaseBuffer(0);
                    }

                    Check(capture.GetNextPacketSize(out packetFrames), "IAudioCaptureClient.GetNextPacketSize");
                }
            }
        }

        private void AppendPacket(IntPtr data, int frames, uint flags)
        {
            if (mono.Length < frames)
            {
                mono = new float[frames];
            }

            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero)
            {
                Array.Clear(mono, 0, frames);
            }
            else
            {
                int bytes = frames * blockAlign;
                if (raw.Length < bytes)
                {
                    raw = new byte[bytes];
                }

                Marshal.Copy(data, raw, 0, bytes);

                int ch = channels;
                switch (kind)
                {
                    case SampleKind.Float32:
                        for (int f = 0, off = 0; f < frames; f++, off += blockAlign)
                        {
                            float sum = 0f;
                            for (int c = 0; c < ch; c++)
                            {
                                sum += BitConverter.ToSingle(raw, off + c * 4);
                            }
                            mono[f] = Clamp(sum / ch);
                        }
                        break;

                    case SampleKind.Pcm16:
                        for (int f = 0, off = 0; f < frames; f++, off += blockAlign)
                        {
                            float sum = 0f;
                            for (int c = 0; c < ch; c++)
                            {
                                sum += BitConverter.ToInt16(raw, off + c * 2) / 32768f;
                            }
                            mono[f] = sum / ch;
                        }
                        break;

                    case SampleKind.Pcm24:
                        for (int f = 0, off = 0; f < frames; f++, off += blockAlign)
                        {
                            float sum = 0f;
                            for (int c = 0; c < ch; c++)
                            {
                                int o = off + c * 3;
                                int v = raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16);
                                if ((v & 0x800000) != 0)
                                {
                                    v |= unchecked((int)0xFF000000);
                                }
                                sum += v / 8388608f;
                            }
                            mono[f] = sum / ch;
                        }
                        break;

                    case SampleKind.Pcm32:
                        for (int f = 0, off = 0; f < frames; f++, off += blockAlign)
                        {
                            float sum = 0f;
                            for (int c = 0; c < ch; c++)
                            {
                                sum += BitConverter.ToInt32(raw, off + c * 4) / 2147483648f;
                            }
                            mono[f] = sum / ch;
                        }
                        break;

                    case SampleKind.Pcm8:
                        for (int f = 0, off = 0; f < frames; f++, off += blockAlign)
                        {
                            float sum = 0f;
                            for (int c = 0; c < ch; c++)
                            {
                                sum += (raw[off + c] - 128) / 128f;
                            }
                            mono[f] = sum / ch;
                        }
                        break;
                }
            }

            state.Append(mono, frames);
        }

        private static float Clamp(float value)
        {
            if (value > 1f)
            {
                return 1f;
            }
            if (value < -1f)
            {
                return -1f;
            }
            return value;
        }

        private void CheckDefaultDevice()
        {
            IMMDevice current = null;
            try
            {
                Check(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out current),
                    "GetDefaultAudioEndpoint(change check)");

                IntPtr idPtr;
                Check(current.GetId(out idPtr), "IMMDevice.GetId(change check)");
                string id;
                try
                {
                    id = Marshal.PtrToStringUni(idPtr);
                }
                finally
                {
                    Marshal.FreeCoTaskMem(idPtr);
                }

                if (!string.Equals(id, deviceId, StringComparison.OrdinalIgnoreCase))
                {
                    throw new COMException("default render endpoint changed",
                        unchecked((int)0x88890004)); // AUDCLNT_E_DEVICE_INVALIDATED
                }
            }
            finally
            {
                if (current != null)
                {
                    Marshal.ReleaseComObject(current);
                }
            }
        }

        private void ParseFormat(IntPtr formatPtr)
        {
            WAVEFORMATEX wf = (WAVEFORMATEX)Marshal.PtrToStructure(formatPtr, typeof(WAVEFORMATEX));

            sampleRate = (int)wf.nSamplesPerSec;
            channels = wf.nChannels;
            blockAlign = wf.nBlockAlign;
            containerBits = wf.wBitsPerSample;

            if (sampleRate <= 0 || channels <= 0 || blockAlign <= 0)
            {
                throw new NotSupportedException("invalid mix format");
            }

            bool isFloat = false;
            bool isPcm = false;

            if (wf.wFormatTag == WAVE_FORMAT_IEEE_FLOAT)
            {
                isFloat = true;
            }
            else if (wf.wFormatTag == WAVE_FORMAT_PCM)
            {
                isPcm = true;
            }
            else if (wf.wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf.cbSize >= 22)
            {
                WAVEFORMATEXTENSIBLE ext =
                    (WAVEFORMATEXTENSIBLE)Marshal.PtrToStructure(formatPtr, typeof(WAVEFORMATEXTENSIBLE));

                if (ext.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)
                {
                    isFloat = true;
                }
                else if (ext.SubFormat == KSDATAFORMAT_SUBTYPE_PCM)
                {
                    isPcm = true;
                }
            }

            if (isFloat)
            {
                if (containerBits != 32)
                {
                    throw new NotSupportedException("unsupported float depth: " + containerBits);
                }
                kind = SampleKind.Float32;
                bytesPerSample = 4;
            }
            else if (isPcm)
            {
                switch (containerBits)
                {
                    case 8:
                        kind = SampleKind.Pcm8;
                        bytesPerSample = 1;
                        break;
                    case 16:
                        kind = SampleKind.Pcm16;
                        bytesPerSample = 2;
                        break;
                    case 24:
                        kind = SampleKind.Pcm24;
                        bytesPerSample = 3;
                        break;
                    case 32:
                        kind = SampleKind.Pcm32;
                        bytesPerSample = 4;
                        break;
                    default:
                        throw new NotSupportedException("unsupported PCM depth: " + containerBits);
                }
            }
            else
            {
                throw new NotSupportedException("unsupported format tag 0x" +
                    wf.wFormatTag.ToString("X4", CultureInfo.InvariantCulture));
            }

            if (blockAlign < channels * bytesPerSample)
            {
                throw new NotSupportedException("blockAlign " + blockAlign + " < channels * bytesPerSample");
            }
        }

        private static string ShortId(string id)
        {
            if (string.IsNullOrEmpty(id))
            {
                return "(null)";
            }
            if (id.Length <= 24)
            {
                return id;
            }
            return id.Substring(0, 24) + "...";
        }

        private static void Check(int hr, string operation)
        {
            if (hr < 0)
            {
                throw new COMException(operation + " failed: HRESULT 0x" +
                    hr.ToString("X8", CultureInfo.InvariantCulture), hr);
            }
        }

        public void Dispose()
        {
            if (client != null)
            {
                client.StopSafe();
                client.Release();
                client = null;
            }

            Release(ref capture);
            Release(ref device);
            Release(ref enumerator);
        }

        private static void Release<T>(ref T comObject) where T : class
        {
            if (comObject == null)
            {
                return;
            }

            try
            {
                Marshal.ReleaseComObject(comObject);
            }
            catch
            {
            }

            comObject = null;
        }
    }

    // Thin facade so the session can use either the classic IAudioClient or the
    // IAudioClient2 activation path (identical leading vtable) transparently.
    internal sealed class AudioClientFacade
    {
        private IAudioClient v1;
        private IAudioClient2 v2;

        public AudioClientFacade(IAudioClient client)
        {
            v1 = client;
        }

        public AudioClientFacade(IAudioClient2 client)
        {
            v2 = client;
        }

        public bool IsVersion2
        {
            get { return v2 != null; }
        }

        public int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity,
            IntPtr format, IntPtr sessionGuid)
        {
            if (v2 != null)
            {
                return v2.Initialize(shareMode, streamFlags, bufferDuration, periodicity, format, sessionGuid);
            }
            return v1.Initialize(shareMode, streamFlags, bufferDuration, periodicity, format, sessionGuid);
        }

        public int GetMixFormat(out IntPtr format)
        {
            if (v2 != null)
            {
                return v2.GetMixFormat(out format);
            }
            return v1.GetMixFormat(out format);
        }

        public int GetService(ref Guid iid, out object service)
        {
            if (v2 != null)
            {
                return v2.GetService(ref iid, out service);
            }
            return v1.GetService(ref iid, out service);
        }

        public int Start()
        {
            return v2 != null ? v2.Start() : v1.Start();
        }

        public int Stop()
        {
            return v2 != null ? v2.Stop() : v1.Stop();
        }

        public void StopSafe()
        {
            try
            {
                Stop();
            }
            catch
            {
            }
        }

        public void Release()
        {
            if (v1 != null)
            {
                try
                {
                    Marshal.ReleaseComObject(v1);
                }
                catch
                {
                }
                v1 = null;
            }

            if (v2 != null)
            {
                try
                {
                    Marshal.ReleaseComObject(v2);
                }
                catch
                {
                }
                v2 = null;
            }
        }
    }

    internal static class Logger
    {
        private static readonly object sync = new object();
        private static long lastTimestamp;

        public static void Write(string message)
        {
            lock (sync)
            {
                long now = Stopwatch.GetTimestamp();
                if (lastTimestamp != 0 && (now - lastTimestamp) < Stopwatch.Frequency * 5)
                {
                    return;
                }
                lastTimestamp = now;

                try
                {
                    Console.Error.WriteLine("[AuroraSpectrum] " +
                        DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + " " + message);
                    Console.Error.Flush();
                }
                catch
                {
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // COM interop: method order below must match the native vtables exactly.
    // ---------------------------------------------------------------------
    internal enum EDataFlow
    {
        eRender = 0,
        eCapture = 1,
        eAll = 2
    }

    internal enum ERole
    {
        eConsole = 0,
        eMultimedia = 1,
        eCommunications = 2
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IntPtr devices);

        [PreserveSig]
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);

        [PreserveSig]
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);

        [PreserveSig]
        int RegisterEndpointNotificationCallback(IntPtr callback);

        [PreserveSig]
        int UnregisterEndpointNotificationCallback(IntPtr callback);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object instance);

        [PreserveSig]
        int OpenPropertyStore(int stgmAccess, out IntPtr properties);

        [PreserveSig]
        int GetId(out IntPtr id);

        [PreserveSig]
        int GetState(out int deviceState);
    }

    [ComImport]
    [Guid("1CB9AD4D-B1AB-4E9A-8F7B-9E8B9D5F0F2B")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig]
        int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity,
            IntPtr format, IntPtr audioSessionGuid);

        [PreserveSig]
        int GetBufferSize(out uint bufferFrames);

        [PreserveSig]
        int GetStreamLatency(out long latency);

        [PreserveSig]
        int GetCurrentPadding(out uint paddingFrames);

        [PreserveSig]
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);

        [PreserveSig]
        int GetMixFormat(out IntPtr deviceFormat);

        [PreserveSig]
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);

        [PreserveSig]
        int Start();

        [PreserveSig]
        int Stop();

        [PreserveSig]
        int Reset();

        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);

        [PreserveSig]
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    // IAudioClient2 adds Activate/SetClientProperties after the inherited
    // IAudioClient vtable; only the base part is declared and used here.
    [ComImport]
    [Guid("726778CD-F60A-4EDA-82DE-E47610CD78AA")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient2
    {
        [PreserveSig]
        int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity,
            IntPtr format, IntPtr audioSessionGuid);

        [PreserveSig]
        int GetBufferSize(out uint bufferFrames);

        [PreserveSig]
        int GetStreamLatency(out long latency);

        [PreserveSig]
        int GetCurrentPadding(out uint paddingFrames);

        [PreserveSig]
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);

        [PreserveSig]
        int GetMixFormat(out IntPtr deviceFormat);

        [PreserveSig]
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);

        [PreserveSig]
        int Start();

        [PreserveSig]
        int Stop();

        [PreserveSig]
        int Reset();

        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);

        [PreserveSig]
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr data, out uint frames, out uint flags,
            out ulong devicePosition, out ulong qpcPosition);

        [PreserveSig]
        int ReleaseBuffer(uint frames);

        [PreserveSig]
        int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public ushort wValidBitsPerSample;
        public uint dwChannelMask;
        public Guid SubFormat;
    }
}
