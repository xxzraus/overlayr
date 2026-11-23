// AuroraDisplay - brightness/contrast (DDC/CI via dxva2.dll, WMI fallback) and
// foreground fullscreen detection. No external dependencies beyond .NET Framework.
//
// Build:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe
//     /platform:anycpu /optimize+ /out:tools\AuroraDisplay.exe
//     tools\AuroraDisplay.cs
//
// Every successful command prints exactly one UTF-8 (no BOM) JSON line to stdout.
// Exit code 0 on success, 1 on failure. Diagnostics go to stderr only when
// AURORA_DISPLAY_DEBUG=1.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

namespace AuroraDisplay
{
    internal static class Program
    {
        private const int MONITOR_DEFAULTTOPRIMARY = 1;
        private const int MONITOR_DEFAULTTONEAREST = 2;
        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int FullscreenTolerancePx = 2;

        #region Win32 interop

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szDevice;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PHYSICAL_MONITOR
        {
            public IntPtr hPhysicalMonitor;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string szPhysicalMonitorDescription;
        }

        private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprcMonitor, IntPtr dwData);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

        [DllImport("user32.dll")]
        private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("dxva2.dll", SetLastError = true)]
        private static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint pdwNumberOfPhysicalMonitors);

        [DllImport("dxva2.dll", SetLastError = true)]
        private static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint dwPhysicalMonitorArraySize,
            [Out] PHYSICAL_MONITOR[] pPhysicalMonitorArray);

        [DllImport("dxva2.dll", SetLastError = true)]
        private static extern bool DestroyPhysicalMonitors(uint dwPhysicalMonitorArraySize,
            [In] PHYSICAL_MONITOR[] pPhysicalMonitorArray);

        [DllImport("dxva2.dll", SetLastError = true)]
        private static extern bool GetMonitorBrightness(IntPtr hMonitor, out uint pdwMinimumBrightness,
            out uint pdwCurrentBrightness, out uint pdwMaximumBrightness);

        [DllImport("dxva2.dll", SetLastError = true)]
        private static extern bool SetMonitorBrightness(IntPtr hMonitor, uint dwNewBrightness);

        [DllImport("dxva2.dll", SetLastError = true)]
        private static extern bool GetMonitorContrast(IntPtr hMonitor, out uint pdwMinimumContrast,
            out uint pdwCurrentContrast, out uint pdwMaximumContrast);

        [DllImport("dxva2.dll", SetLastError = true)]
        private static extern bool SetMonitorContrast(IntPtr hMonitor, uint dwNewContrast);

        #endregion

        private struct DdcReading
        {
            public bool BrightnessSupported;
            public int? Brightness;
            public bool ContrastSupported;
            public int? Contrast;
            public string Description;
            public int Error;
        }

        #region Entry point

        private static int Main(string[] args)
        {
            try
            {
                SetProcessDPIAware();
            }
            catch
            {
                // Non-fatal: coordinates stay DPI-virtualized on scaled displays.
            }

            try
            {
                if (args.Length == 0)
                {
                    return Fail("usage: AuroraDisplay.exe brightness get|set <0-100> | contrast get|set <0-100> | fullscreen | list");
                }

                switch (args[0].ToLowerInvariant())
                {
                    case "brightness":
                        return CmdBrightness(args);
                    case "contrast":
                        return CmdContrast(args);
                    case "fullscreen":
                        return CmdFullscreen();
                    case "list":
                        return CmdList();
                    default:
                        return Fail("unknown command: " + args[0]);
                }
            }
            catch (Exception ex)
            {
                return Fail(ex.GetType().Name + ": " + ex.Message);
            }
        }

        #endregion

        #region Commands

        private static int CmdBrightness(string[] args)
        {
            if (args.Length < 2)
            {
                return Fail("usage: brightness get|set <0-100>");
            }

            string op = args[1].ToLowerInvariant();

            if (op == "get")
            {
                int? brightness;
                int? contrast;
                string source;
                int ddcError;
                bool supported = ReadState(out brightness, out contrast, out source, out ddcError);
                if (!supported)
                {
                    Dbg("ddc brightness unavailable: win32=0x" + ddcError.ToString("X8", CultureInfo.InvariantCulture));
                }
                return Emit(StateJson(brightness, contrast, supported, source));
            }

            if (op == "set")
            {
                int percent;
                if (args.Length < 3 || !TryParsePercent(args[2], out percent))
                {
                    return Fail("brightness set requires an integer 0-100");
                }

                int ddcError;
                if (DdcSet(GetPrimaryMonitor(), true, percent, out ddcError))
                {
                    int? brightness;
                    int? contrast;
                    string source;
                    int ignored;
                    if (!ReadState(out brightness, out contrast, out source, out ignored))
                    {
                        brightness = percent;
                        contrast = null;
                        source = "ddc";
                    }
                    return Emit(StateJson(brightness, contrast, true, "ddc"));
                }

                Dbg("ddc brightness set failed: win32=0x" + ddcError.ToString("X8", CultureInfo.InvariantCulture));

                if (WmiWrite(percent))
                {
                    int value;
                    int? reported = WmiRead(out value) ? (int?)value : (int?)percent;
                    return Emit(StateJson(reported, null, true, "wmi"));
                }

                return Fail("brightness is not adjustable (ddc error 0x" + ddcError.ToString("X8", CultureInfo.InvariantCulture) + ", wmi unavailable)");
            }

            return Fail("usage: brightness get|set <0-100>");
        }

        private static int CmdContrast(string[] args)
        {
            if (args.Length < 2)
            {
                return Fail("usage: contrast get|set <0-100>");
            }

            string op = args[1].ToLowerInvariant();

            if (op == "get")
            {
                DdcReading reading;
                bool supported = DdcRead(GetPrimaryMonitor(), out reading) && reading.ContrastSupported;
                int? contrast = supported ? reading.Contrast : null;
                return Emit(ContrastJson(contrast, supported));
            }

            if (op == "set")
            {
                int percent;
                if (args.Length < 3 || !TryParsePercent(args[2], out percent))
                {
                    return Fail("contrast set requires an integer 0-100");
                }

                int ddcError;
                if (!DdcSet(GetPrimaryMonitor(), false, percent, out ddcError))
                {
                    return Fail("contrast is not adjustable via ddc (error 0x" + ddcError.ToString("X8", CultureInfo.InvariantCulture) + ")");
                }

                DdcReading reading;
                int? contrast = null;
                if (DdcRead(GetPrimaryMonitor(), out reading) && reading.ContrastSupported)
                {
                    contrast = reading.Contrast;
                }
                if (!contrast.HasValue)
                {
                    contrast = percent;
                }
                return Emit(ContrastJson(contrast, true));
            }

            return Fail("usage: contrast get|set <0-100>");
        }

        private static int CmdFullscreen()
        {
            Stopwatch sw = Stopwatch.StartNew();
            IntPtr hwnd = GetForegroundWindow();
            bool fullscreen = false;
            string app = string.Empty;
            string title = string.Empty;

            if (hwnd != IntPtr.Zero)
            {
                title = GetWindowTitle(hwnd);
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                app = GetProcessName(pid);
                fullscreen = IsFullscreenWindow(hwnd, pid);
            }

            sw.Stop();
            Dbg("fullscreen elapsed_ms=" + sw.Elapsed.TotalMilliseconds.ToString("0.000", CultureInfo.InvariantCulture));

            StringBuilder sb = new StringBuilder(160);
            sb.Append("{\"ok\":true,\"fullscreen\":").Append(fullscreen ? "true" : "false");
            sb.Append(",\"app\":").Append(Quote(app));
            sb.Append(",\"title\":").Append(Quote(title));
            sb.Append('}');
            return Emit(sb.ToString());
        }

        private static int CmdList()
        {
            List<string> monitors = new List<string>();
            int index = 0;

            MonitorEnumProc callback = delegate(IntPtr hMonitor, IntPtr hdc, IntPtr lprcMonitor, IntPtr dwData)
            {
                MONITORINFOEX info = new MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (!GetMonitorInfo(hMonitor, ref info))
                {
                    return true;
                }

                DdcReading reading;
                bool ddc = DdcRead(hMonitor, out reading);
                bool primary = (info.dwFlags & 1u) != 0;

                StringBuilder sb = new StringBuilder(220);
                sb.Append("{\"index\":").Append(index);
                sb.Append(",\"device\":").Append(Quote(info.szDevice));
                sb.Append(",\"primary\":").Append(primary ? "true" : "false");
                sb.Append(",\"description\":").Append(Quote(reading.Description));
                sb.Append(",\"ddc\":").Append(ddc ? "true" : "false");
                sb.Append(",\"brightness\":").Append(JsonInt(ddc ? reading.Brightness : null));
                sb.Append(",\"contrast\":").Append(JsonInt(ddc && reading.ContrastSupported ? reading.Contrast : null));
                sb.Append('}');
                monitors.Add(sb.ToString());
                index++;
                return true;
            };

            if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero))
            {
                return Fail("EnumDisplayMonitors failed: win32=" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
            }

            int wmiValue;
            bool wmiSupported = WmiRead(out wmiValue);

            StringBuilder json = new StringBuilder(256);
            json.Append("{\"ok\":true,\"wmi\":").Append(wmiSupported ? "true" : "false");
            json.Append(",\"monitors\":[").Append(string.Join(",", monitors.ToArray())).Append("]}");
            return Emit(json.ToString());
        }

        #endregion

        #region State reading

        private static bool ReadState(out int? brightness, out int? contrast, out string source, out int ddcError)
        {
            brightness = null;
            contrast = null;
            source = null;
            ddcError = 0;

            IntPtr primary = GetPrimaryMonitor();
            if (primary != IntPtr.Zero)
            {
                DdcReading reading;
                if (DdcRead(primary, out reading))
                {
                    brightness = reading.Brightness;
                    contrast = reading.Contrast;
                    source = "ddc";
                    return true;
                }
                ddcError = reading.Error;
            }
            else
            {
                ddcError = 6; // ERROR_INVALID_HANDLE
            }

            int wmiBrightness;
            if (WmiRead(out wmiBrightness))
            {
                brightness = wmiBrightness;
                contrast = null;
                source = "wmi";
                return true;
            }

            return false;
        }

        private static IntPtr GetPrimaryMonitor()
        {
            POINT origin = new POINT();
            return MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
        }

        private static bool DdcRead(IntPtr hMonitor, out DdcReading reading)
        {
            try
            {
                return DdcReadCore(hMonitor, out reading);
            }
            catch (Exception ex)
            {
                reading = new DdcReading();
                reading.Error = Marshal.GetHRForException(ex);
                Dbg("ddc read exception: " + ex.GetType().Name + ": " + ex.Message);
                return false;
            }
        }

        private static bool DdcReadCore(IntPtr hMonitor, out DdcReading reading)
        {
            reading = new DdcReading();
            if (hMonitor == IntPtr.Zero)
            {
                reading.Error = 6;
                return false;
            }

            uint count;
            if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count) || count == 0)
            {
                reading.Error = Marshal.GetLastWin32Error();
                return false;
            }

            PHYSICAL_MONITOR[] physical = new PHYSICAL_MONITOR[count];
            if (!GetPhysicalMonitorsFromHMONITOR(hMonitor, count, physical))
            {
                reading.Error = Marshal.GetLastWin32Error();
                return false;
            }

            try
            {
                foreach (PHYSICAL_MONITOR monitor in physical)
                {
                    uint min;
                    uint current;
                    uint max;
                    if (!GetMonitorBrightness(monitor.hPhysicalMonitor, out min, out current, out max))
                    {
                        reading.Error = Marshal.GetLastWin32Error();
                        continue;
                    }
                    if (max <= min)
                    {
                        reading.Error = 87; // ERROR_INVALID_PARAMETER
                        continue;
                    }

                    reading.BrightnessSupported = true;
                    reading.Brightness = ToPercent(current, min, max);
                    reading.Description = monitor.szPhysicalMonitorDescription;
                    reading.Error = 0;

                    uint cMin;
                    uint cCurrent;
                    uint cMax;
                    if (GetMonitorContrast(monitor.hPhysicalMonitor, out cMin, out cCurrent, out cMax) && cMax > cMin)
                    {
                        reading.ContrastSupported = true;
                        reading.Contrast = ToPercent(cCurrent, cMin, cMax);
                    }
                    return true;
                }

                return false;
            }
            finally
            {
                DestroyPhysicalMonitors(count, physical);
            }
        }

        private static bool DdcSet(IntPtr hMonitor, bool setBrightness, int percent, out int error)
        {
            try
            {
                return DdcSetCore(hMonitor, setBrightness, percent, out error);
            }
            catch (Exception ex)
            {
                error = Marshal.GetHRForException(ex);
                Dbg("ddc set exception: " + ex.GetType().Name + ": " + ex.Message);
                return false;
            }
        }

        private static bool DdcSetCore(IntPtr hMonitor, bool setBrightness, int percent, out int error)
        {
            error = 0;
            if (hMonitor == IntPtr.Zero)
            {
                error = 6;
                return false;
            }

            uint count;
            if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count) || count == 0)
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }

            PHYSICAL_MONITOR[] physical = new PHYSICAL_MONITOR[count];
            if (!GetPhysicalMonitorsFromHMONITOR(hMonitor, count, physical))
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }

            bool applied = false;
            try
            {
                foreach (PHYSICAL_MONITOR monitor in physical)
                {
                    if (setBrightness)
                    {
                        uint min;
                        uint current;
                        uint max;
                        if (!GetMonitorBrightness(monitor.hPhysicalMonitor, out min, out current, out max))
                        {
                            error = Marshal.GetLastWin32Error();
                            continue;
                        }
                        if (max <= min)
                        {
                            error = 87;
                            continue;
                        }

                        uint target = FromPercent(percent, min, max);
                        Dbg("ddc brightness: min=" + min.ToString(CultureInfo.InvariantCulture) +
                            " cur=" + current.ToString(CultureInfo.InvariantCulture) +
                            " max=" + max.ToString(CultureInfo.InvariantCulture) +
                            " target=" + target.ToString(CultureInfo.InvariantCulture));
                        if (!SetMonitorBrightness(monitor.hPhysicalMonitor, target))
                        {
                            error = Marshal.GetLastWin32Error();
                            Dbg("SetMonitorBrightness failed: win32=0x" + error.ToString("X8", CultureInfo.InvariantCulture));
                            continue;
                        }
                    }
                    else
                    {
                        uint min;
                        uint current;
                        uint max;
                        if (!GetMonitorContrast(monitor.hPhysicalMonitor, out min, out current, out max))
                        {
                            error = Marshal.GetLastWin32Error();
                            continue;
                        }
                        if (max <= min)
                        {
                            error = 87;
                            continue;
                        }

                        uint target = FromPercent(percent, min, max);
                        Dbg("ddc contrast: min=" + min.ToString(CultureInfo.InvariantCulture) +
                            " cur=" + current.ToString(CultureInfo.InvariantCulture) +
                            " max=" + max.ToString(CultureInfo.InvariantCulture) +
                            " target=" + target.ToString(CultureInfo.InvariantCulture));
                        if (!SetMonitorContrast(monitor.hPhysicalMonitor, target))
                        {
                            error = Marshal.GetLastWin32Error();
                            Dbg("SetMonitorContrast failed: win32=0x" + error.ToString("X8", CultureInfo.InvariantCulture));
                            continue;
                        }
                    }

                    applied = true;
                    break;
                }
            }
            finally
            {
                DestroyPhysicalMonitors(count, physical);
            }

            return applied;
        }

        private static int ToPercent(uint value, uint min, uint max)
        {
            if (max <= min)
            {
                return 0;
            }
            return (int)Math.Round((value - min) * 100.0 / (max - min), MidpointRounding.AwayFromZero);
        }

        private static uint FromPercent(int percent, uint min, uint max)
        {
            if (max <= min)
            {
                return min;
            }
            return min + (uint)Math.Round(percent * (max - min) / 100.0, MidpointRounding.AwayFromZero);
        }

        #endregion

        #region WMI

        private static bool WmiRead(out int brightness)
        {
            brightness = 0;
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "root\\wmi", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
                {
                    using (ManagementObjectCollection results = searcher.Get())
                    {
                        foreach (ManagementBaseObject item in results)
                        {
                            using (ManagementObject monitor = (ManagementObject)item)
                            {
                                object value = monitor["CurrentBrightness"];
                                if (value != null)
                                {
                                    brightness = Convert.ToInt32(value, CultureInfo.InvariantCulture);
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            catch (ManagementException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
            catch (COMException)
            {
            }
            return false;
        }

        private static bool WmiWrite(int percent)
        {
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "root\\wmi", "SELECT * FROM WmiMonitorBrightnessMethods"))
                {
                    using (ManagementObjectCollection results = searcher.Get())
                    {
                        foreach (ManagementBaseObject item in results)
                        {
                            using (ManagementObject monitor = (ManagementObject)item)
                            {
                                using (ManagementBaseObject inParams = monitor.GetMethodParameters("WmiSetBrightness"))
                                {
                                    if (inParams == null)
                                    {
                                        continue;
                                    }
                                    inParams["Timeout"] = (uint)0;
                                    inParams["Brightness"] = (byte)percent;
                                    monitor.InvokeMethod("WmiSetBrightness", inParams, null);
                                }
                                return true;
                            }
                        }
                    }
                }
            }
            catch (ManagementException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
            catch (COMException)
            {
            }
            return false;
        }

        #endregion

        #region Fullscreen detection

        private static bool IsFullscreenWindow(IntPtr hwnd, uint pid)
        {
            if (!IsWindowVisible(hwnd) || IsIconic(hwnd))
            {
                return false;
            }

            int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
            if ((exStyle & WS_EX_TOOLWINDOW) != 0)
            {
                return false;
            }

            string className = GetWindowClassName(hwnd);
            if (className == "Progman" || className == "WorkerW" ||
                className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd")
            {
                return false;
            }

            if (pid == (uint)Process.GetCurrentProcess().Id || IsExcludedProcessName(GetProcessName(pid)))
            {
                return false;
            }

            RECT windowRect;
            if (!GetWindowRect(hwnd, out windowRect))
            {
                return false;
            }

            IntPtr hMonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if (hMonitor == IntPtr.Zero)
            {
                return false;
            }

            MONITORINFOEX monitorInfo = new MONITORINFOEX();
            monitorInfo.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (!GetMonitorInfo(hMonitor, ref monitorInfo))
            {
                return false;
            }

            RECT screen = monitorInfo.rcMonitor;
            return windowRect.Left <= screen.Left + FullscreenTolerancePx
                && windowRect.Top <= screen.Top + FullscreenTolerancePx
                && windowRect.Right >= screen.Right - FullscreenTolerancePx
                && windowRect.Bottom >= screen.Bottom - FullscreenTolerancePx;
        }

        private static bool IsExcludedProcessName(string processName)
        {
            if (string.IsNullOrEmpty(processName))
            {
                return false;
            }

            string name = processName.ToLowerInvariant();
            if (name.EndsWith(".exe", StringComparison.Ordinal))
            {
                name = name.Substring(0, name.Length - 4);
            }

            return name.StartsWith("aurora", StringComparison.Ordinal)
                || name == "overlayr"
                || name == "overlay"
                || name == "electron";
        }

        private static string GetWindowTitle(IntPtr hwnd)
        {
            StringBuilder title = new StringBuilder(512);
            int length = GetWindowText(hwnd, title, title.Capacity);
            return length > 0 ? title.ToString() : string.Empty;
        }

        private static string GetWindowClassName(IntPtr hwnd)
        {
            StringBuilder name = new StringBuilder(256);
            int length = GetClassName(hwnd, name, name.Capacity);
            return length > 0 ? name.ToString() : string.Empty;
        }

        private static string GetProcessName(uint pid)
        {
            try
            {
                using (Process process = Process.GetProcessById((int)pid))
                {
                    return process.ProcessName + ".exe";
                }
            }
            catch
            {
                return string.Empty;
            }
        }

        #endregion

        #region Output

        private static int Emit(string json)
        {
            try
            {
                using (StreamWriter stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
                {
                    stdout.NewLine = "\n";
                    stdout.Write(json);
                    stdout.Write('\n');
                    stdout.Flush();
                }
            }
            catch (IOException)
            {
            }
            return 0;
        }

        private static int Fail(string message)
        {
            Emit("{\"ok\":false,\"error\":" + Quote(message) + "}");
            return 1;
        }

        private static string StateJson(int? brightness, int? contrast, bool supported, string source)
        {
            StringBuilder sb = new StringBuilder(140);
            sb.Append("{\"ok\":true,\"brightness\":").Append(JsonInt(brightness));
            sb.Append(",\"contrast\":").Append(JsonInt(contrast));
            sb.Append(",\"supported\":").Append(supported ? "true" : "false");
            if (supported && !string.IsNullOrEmpty(source))
            {
                sb.Append(",\"source\":").Append(Quote(source));
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static string ContrastJson(int? contrast, bool supported)
        {
            StringBuilder sb = new StringBuilder(110);
            sb.Append("{\"ok\":true,\"contrast\":").Append(JsonInt(contrast));
            sb.Append(",\"supported\":").Append(supported ? "true" : "false");
            if (supported)
            {
                sb.Append(",\"source\":\"ddc\"");
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static string JsonInt(int? value)
        {
            return value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : "null";
        }

        private static string Quote(string value)
        {
            if (value == null)
            {
                value = string.Empty;
            }

            StringBuilder sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char ch in value)
            {
                switch (ch)
                {
                    case '"':
                        sb.Append("\\\"");
                        break;
                    case '\\':
                        sb.Append("\\\\");
                        break;
                    case '\b':
                        sb.Append("\\b");
                        break;
                    case '\f':
                        sb.Append("\\f");
                        break;
                    case '\n':
                        sb.Append("\\n");
                        break;
                    case '\r':
                        sb.Append("\\r");
                        break;
                    case '\t':
                        sb.Append("\\t");
                        break;
                    default:
                        if (ch < 0x20)
                        {
                            sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(ch);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private static bool TryParsePercent(string text, out int percent)
        {
            percent = 0;
            int parsed;
            if (!int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
            {
                return false;
            }
            if (parsed < 0 || parsed > 100)
            {
                return false;
            }
            percent = parsed;
            return true;
        }

        private static void Dbg(string message)
        {
            if (Environment.GetEnvironmentVariable("AURORA_DISPLAY_DEBUG") == "1")
            {
                try
                {
                    Console.Error.WriteLine(message);
                }
                catch
                {
                }
            }
        }

        #endregion
    }
}
