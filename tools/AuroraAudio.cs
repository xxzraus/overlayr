using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AuroraAudio
{
    internal static class Native
    {
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        internal class MMDeviceEnumeratorComObject { }

        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
            [PreserveSig] int GetDevice(string id, out IMMDevice device);
            [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
            [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
        }

        [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
            [PreserveSig] int OpenPropertyStore(int stgmAccess, out IntPtr properties);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetState(out int state);
        }

        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioEndpointVolume
        {
            [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
            [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
            [PreserveSig] int GetChannelCount(out uint count);
            [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid eventContext);
            [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
            [PreserveSig] int GetMasterVolumeLevel(out float level);
            [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
            [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid eventContext);
            [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
            [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
            [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
            [PreserveSig] int SetMute(int mute, ref Guid eventContext);
            [PreserveSig] int GetMute(out int mute);
            [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
            [PreserveSig] int VolumeStepUp(ref Guid eventContext);
            [PreserveSig] int VolumeStepDown(ref Guid eventContext);
            [PreserveSig] int QueryHardwareSupport(out uint mask);
            [PreserveSig] int GetVolumeRange(out float min, out float max, out float increment);
        }

        // IAudioSessionManager2 : IAudioSessionManager
        // The vtable order is critical: IAudioSessionManager's two methods come first,
        // then IAudioSessionManager2's own methods.
        [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioSessionManager2
        {
            // --- IAudioSessionManager ---
            [PreserveSig] int GetAudioSessionControl(ref Guid audioSessionGuid, uint streamFlags, out IAudioSessionControl sessionControl);
            [PreserveSig] int GetSimpleAudioVolume(ref Guid audioSessionGuid, uint streamFlags, out ISimpleAudioVolume audioVolume);
            // --- IAudioSessionManager2 ---
            [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
            [PreserveSig] int RegisterSessionNotification(IntPtr sessionNotification);
            [PreserveSig] int UnregisterSessionNotification(IntPtr sessionNotification);
            [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
            [PreserveSig] int UnregisterDuckNotification(IntPtr duckNotification);
        }

        [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioSessionEnumerator
        {
            [PreserveSig] int GetCount(out int sessionCount);
            [PreserveSig] int GetSession(int sessionIndex, out IAudioSessionControl session);
        }

        [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioSessionControl
        {
            [PreserveSig] int GetState(out int state);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
            [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
            [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
            [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
            [PreserveSig] int GetGroupingParam(out Guid groupingParam);
            [PreserveSig] int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr newNotifications);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr newNotifications);
        }

        // IAudioSessionControl2 : IAudioSessionControl.
        // Base methods must be declared first, otherwise GetProcessId would land on the
        // wrong vtable slot.
        [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioSessionControl2
        {
            // --- IAudioSessionControl ---
            [PreserveSig] int GetState(out int state);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
            [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
            [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
            [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
            [PreserveSig] int GetGroupingParam(out Guid groupingParam);
            [PreserveSig] int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr newNotifications);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr newNotifications);
            // --- IAudioSessionControl2 ---
            [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionIdentifier);
            [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionInstanceIdentifier);
            [PreserveSig] int GetProcessId(out uint processId);
            [PreserveSig] int IsSystemSoundsSession();
            [PreserveSig] int SetDuckingPreference(int optOut);
        }

        [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface ISimpleAudioVolume
        {
            [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
            [PreserveSig] int GetMasterVolume(out float level);
            [PreserveSig] int SetMute(int mute, ref Guid eventContext);
            [PreserveSig] int GetMute(out int mute);
        }

        internal static readonly Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        internal static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        internal static readonly Guid IID_ISimpleAudioVolume = new Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8");
    }

    internal sealed class SessionInfo
    {
        public uint Pid;
        public string DisplayName;   // e.g. "Spotify.exe"
        public int State;            // 0 Inactive, 1 Active, 2 Expired
        public Native.ISimpleAudioVolume Volume;
    }

    internal static class Program
    {
        private static Guid _ctx = Guid.Empty;

        private static readonly StreamWriter Stdout =
            new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

        private static void Out(string line)
        {
            Stdout.WriteLine(line);
        }

        private static string Quote(string s)
        {
            if (s == null) return "\"\"";
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private static Native.IMMDevice GetDefaultRenderDevice()
        {
            var enumerator = (Native.IMMDeviceEnumerator)new Native.MMDeviceEnumeratorComObject();
            Native.IMMDevice device;
            int hr = enumerator.GetDefaultAudioEndpoint(0, 0, out device); // eRender, eConsole
            if (hr != 0 || device == null) throw new COMException("GetDefaultAudioEndpoint failed", hr);
            return device;
        }

        private static Native.IAudioEndpointVolume OpenEndpoint()
        {
            Native.IMMDevice device = GetDefaultRenderDevice();
            Guid iid = Native.IID_IAudioEndpointVolume;
            object obj;
            int hr = device.Activate(ref iid, 1 /*CLSCTX_INPROC_SERVER*/, IntPtr.Zero, out obj);
            if (hr != 0) hr = device.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out obj);
            if (hr != 0 || obj == null) throw new COMException("Activate failed", hr);
            return (Native.IAudioEndpointVolume)obj;
        }

        private static Native.IAudioSessionManager2 OpenSessionManager()
        {
            Native.IMMDevice device = GetDefaultRenderDevice();
            Guid iid = Native.IID_IAudioSessionManager2;
            object obj;
            int hr = device.Activate(ref iid, 1 /*CLSCTX_INPROC_SERVER*/, IntPtr.Zero, out obj);
            if (hr != 0) hr = device.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out obj);
            if (hr != 0 || obj == null) throw new COMException("Activate IAudioSessionManager2 failed", hr);
            return (Native.IAudioSessionManager2)obj;
        }

        private static string ReadState(Native.IAudioEndpointVolume vol)
        {
            float scalar;
            int hr = vol.GetMasterVolumeLevelScalar(out scalar);
            if (hr != 0) throw new COMException("GetMasterVolumeLevelScalar failed", hr);
            int mute;
            hr = vol.GetMute(out mute);
            if (hr != 0) throw new COMException("GetMute failed", hr);
            int pct = (int)Math.Round(scalar * 100f, MidpointRounding.AwayFromZero);
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;
            return "{\"ok\":true,\"volume\":" + pct.ToString(CultureInfo.InvariantCulture) +
                   ",\"muted\":" + (mute != 0 ? "true" : "false") + "}";
        }

        private static string StateName(int state)
        {
            switch (state)
            {
                case 0: return "Inactive";
                case 1: return "Active";
                case 2: return "Expired";
                default: return "Unknown";
            }
        }

        private static string ProcessDisplayName(uint pid)
        {
            if (pid == 0) return "System";
            try
            {
                using (Process p = Process.GetProcessById((int)pid))
                {
                    return p.ProcessName + ".exe";
                }
            }
            catch
            {
                return "pid-" + pid.ToString(CultureInfo.InvariantCulture) + ".exe";
            }
        }

        // QI an IAudioSessionControl RCW for ISimpleAudioVolume.
        private static Native.ISimpleAudioVolume GetVolumeInterface(Native.IAudioSessionControl control)
        {
            IntPtr unk = Marshal.GetIUnknownForObject(control);
            try
            {
                Guid iid = Native.IID_ISimpleAudioVolume;
                IntPtr pVol;
                int hr = Marshal.QueryInterface(unk, ref iid, out pVol);
                if (hr != 0 || pVol == IntPtr.Zero) return null;
                try
                {
                    return (Native.ISimpleAudioVolume)Marshal.GetObjectForIUnknown(pVol);
                }
                finally
                {
                    Marshal.Release(pVol);
                }
            }
            finally
            {
                Marshal.Release(unk);
            }
        }

        private static List<SessionInfo> EnumerateSessions()
        {
            var result = new List<SessionInfo>();
            Native.IAudioSessionManager2 mgr = OpenSessionManager();
            Native.IAudioSessionEnumerator enumerator;
            int hr = mgr.GetSessionEnumerator(out enumerator);
            if (hr != 0 || enumerator == null) throw new COMException("GetSessionEnumerator failed", hr);

            int count;
            hr = enumerator.GetCount(out count);
            if (hr != 0) throw new COMException("GetCount failed", hr);

            for (int i = 0; i < count; i++)
            {
                // Never let one dead session abort the whole listing.
                try
                {
                    Native.IAudioSessionControl control;
                    hr = enumerator.GetSession(i, out control);
                    if (hr != 0 || control == null) continue;

                    var info = new SessionInfo();
                    info.DisplayName = "unknown.exe";

                    try
                    {
                        var c2 = control as Native.IAudioSessionControl2;
                        if (c2 != null)
                        {
                            uint pid;
                            if (c2.GetProcessId(out pid) == 0) info.Pid = pid;
                        }
                    }
                    catch { }

                    try
                    {
                        int state;
                        if (control.GetState(out state) == 0) info.State = state;
                    }
                    catch { }

                    try { info.DisplayName = ProcessDisplayName(info.Pid); }
                    catch { }

                    try { info.Volume = GetVolumeInterface(control); }
                    catch { }

                    result.Add(info);
                }
                catch { }
            }

            return result;
        }

        private static bool NameMatches(SessionInfo session, string wanted)
        {
            string w = wanted;
            if (w.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                w = w.Substring(0, w.Length - 4);

            // Allow matching by pid as well.
            uint wantedPid;
            if (uint.TryParse(w, NumberStyles.Integer, CultureInfo.InvariantCulture, out wantedPid) && wantedPid == session.Pid)
                return true;

            string s = session.DisplayName ?? "";
            if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                s = s.Substring(0, s.Length - 4);

            return string.Equals(s, w, StringComparison.OrdinalIgnoreCase);
        }

        private static List<SessionInfo> FindMatches(string name)
        {
            var all = EnumerateSessions();
            var matches = new List<SessionInfo>();
            foreach (var s in all)
            {
                if (NameMatches(s, name)) matches.Add(s);
            }
            return matches;
        }

        private static SessionInfo SelectPrimary(List<SessionInfo> matches)
        {
            foreach (var s in matches)
            {
                if (s.State == 1) return s;
            }
            return matches.Count > 0 ? matches[0] : null;
        }

        private static bool TryReadVolume(SessionInfo s, out int pct, out bool muted)
        {
            pct = 0;
            muted = false;
            if (s == null || s.Volume == null) return false;
            try
            {
                float scalar;
                if (s.Volume.GetMasterVolume(out scalar) != 0) return false;
                int m;
                if (s.Volume.GetMute(out m) != 0) return false;
                int v = (int)Math.Round(scalar * 100f, MidpointRounding.AwayFromZero);
                if (v < 0) v = 0;
                if (v > 100) v = 100;
                pct = v;
                muted = m != 0;
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string SessionJson(SessionInfo s)
        {
            int pct;
            bool muted;
            if (!TryReadVolume(s, out pct, out muted))
            {
                pct = 0;
                muted = false;
            }
            return "{\"pid\":" + s.Pid.ToString(CultureInfo.InvariantCulture) +
                   ",\"name\":" + Quote(s.DisplayName) +
                   ",\"volume\":" + pct.ToString(CultureInfo.InvariantCulture) +
                   ",\"muted\":" + (muted ? "true" : "false") +
                   ",\"state\":" + Quote(StateName(s.State)) + "}";
        }

        private static int RunApps()
        {
            List<SessionInfo> sessions = EnumerateSessions();
            var sb = new StringBuilder("{\"ok\":true,\"sessions\":[");
            for (int i = 0; i < sessions.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(SessionJson(sessions[i]));
            }
            sb.Append("]}");
            Out(sb.ToString());
            return 0;
        }

        // Shared implementation of app-get / app-set / app-mute / app-toggle-mute.
        private static int RunAppCommand(string cmd, string[] args)
        {
            if (args.Length < 2 || string.IsNullOrEmpty(args[1]))
            {
                Out("{\"ok\":false,\"error\":\"missing-argument\"}");
                return 1;
            }

            string wanted = args[1];

            if (cmd == "app-set" || cmd == "app-mute")
            {
                if (args.Length < 3)
                {
                    Out("{\"ok\":false,\"error\":\"missing-argument\"}");
                    return 1;
                }
            }

            int volumePct = 0;
            int muteValue = 0;
            if (cmd == "app-set")
            {
                if (!int.TryParse(args[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out volumePct))
                {
                    double d;
                    if (!double.TryParse(args[2], NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                    {
                        Out("{\"ok\":false,\"error\":\"invalid-volume\"}");
                        return 1;
                    }
                    volumePct = (int)Math.Round(d, MidpointRounding.AwayFromZero);
                }
                if (volumePct < 0) volumePct = 0;
                if (volumePct > 100) volumePct = 100;
            }
            else if (cmd == "app-mute")
            {
                muteValue = args[2] == "1" ? 1 : 0;
            }

            List<SessionInfo> matches = FindMatches(wanted);
            if (matches.Count == 0)
            {
                Out("{\"ok\":false,\"error\":\"session-not-found\"}");
                return 1;
            }

            // Apply to every session with this process name; tolerate sessions that vanish.
            int applied = 0;
            foreach (var s in matches)
            {
                try
                {
                    if (s.Volume == null) continue;
                    if (cmd == "app-set")
                    {
                        Guid ctx = _ctx;
                        if (s.Volume.SetMasterVolume((float)(volumePct / 100.0), ref ctx) != 0) continue;
                    }
                    else if (cmd == "app-mute")
                    {
                        Guid ctx = _ctx;
                        if (s.Volume.SetMute(muteValue, ref ctx) != 0) continue;
                    }
                    else if (cmd == "app-toggle-mute")
                    {
                        int m;
                        if (s.Volume.GetMute(out m) != 0) continue;
                        Guid ctx = _ctx;
                        if (s.Volume.SetMute(m == 0 ? 1 : 0, ref ctx) != 0) continue;
                    }
                    applied++;
                }
                catch { }
            }

            if (cmd != "app-get" && applied == 0)
            {
                Out("{\"ok\":false,\"error\":\"session-not-found\"}");
                return 1;
            }

            SessionInfo chosen = null;
            int pct = 0;
            bool muted = false;
            // Prefer the first Active session, fall back to any readable one.
            SessionInfo primary = SelectPrimary(matches);
            if (primary != null && TryReadVolume(primary, out pct, out muted))
            {
                chosen = primary;
            }
            else
            {
                foreach (var s in matches)
                {
                    if (s == primary) continue;
                    if (TryReadVolume(s, out pct, out muted)) { chosen = s; break; }
                }
            }

            if (chosen == null)
            {
                Out("{\"ok\":false,\"error\":\"session-not-found\"}");
                return 1;
            }

            var sb = new StringBuilder("{\"ok\":true,\"name\":");
            sb.Append(Quote(chosen.DisplayName));
            sb.Append(",\"pid\":").Append(chosen.Pid.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"volume\":").Append(pct.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"muted\":").Append(muted ? "true" : "false");
            if (matches.Count > 1)
                sb.Append(",\"count\":").Append(matches.Count.ToString(CultureInfo.InvariantCulture));
            sb.Append('}');
            Out(sb.ToString());
            return 0;
        }

        private static int RunSystemCommand(string cmd, string[] args)
        {
            if (cmd != "get" && cmd != "set" && cmd != "step" && cmd != "mute" && cmd != "toggle-mute")
            {
                Out("{\"ok\":false,\"error\":\"unknown-command\"}");
                return 1;
            }

            var vol = OpenEndpoint();
            switch (cmd)
            {
                case "get":
                    break;
                case "set":
                {
                    double pct = args.Length > 1 ? double.Parse(args[1], CultureInfo.InvariantCulture) : 50;
                    if (pct < 0) pct = 0;
                    if (pct > 100) pct = 100;
                    Guid ctx = _ctx;
                    vol.SetMasterVolumeLevelScalar((float)(pct / 100.0), ref ctx);
                    break;
                }
                case "step":
                {
                    double delta = args.Length > 1 ? double.Parse(args[1], CultureInfo.InvariantCulture) : 5;
                    float cur;
                    vol.GetMasterVolumeLevelScalar(out cur);
                    double next = cur * 100.0 + delta;
                    if (next < 0) next = 0;
                    if (next > 100) next = 100;
                    Guid ctx = _ctx;
                    vol.SetMasterVolumeLevelScalar((float)(next / 100.0), ref ctx);
                    break;
                }
                case "mute":
                {
                    int on = args.Length > 1 && args[1] == "1" ? 1 : 0;
                    Guid ctx = _ctx;
                    vol.SetMute(on, ref ctx);
                    break;
                }
                case "toggle-mute":
                {
                    int mute;
                    vol.GetMute(out mute);
                    Guid ctx = _ctx;
                    vol.SetMute(mute == 0 ? 1 : 0, ref ctx);
                    break;
                }
            }
            Out(ReadState(vol));
            return 0;
        }

        public static int Main(string[] args)
        {
            string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "get";
            try
            {
                switch (cmd)
                {
                    case "apps":
                        return RunApps();
                    case "app-get":
                    case "app-set":
                    case "app-mute":
                    case "app-toggle-mute":
                        return RunAppCommand(cmd, args);
                    default:
                        return RunSystemCommand(cmd, args);
                }
            }
            catch (Exception ex)
            {
                Out("{\"ok\":false,\"error\":" + Quote(ex.Message) + "}");
                return 1;
            }
        }
    }
}
