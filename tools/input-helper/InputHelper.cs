// CS2 Tasks — помощник ввода. НЕ трогает игру: не внедряется в процесс и не читает его память.
// Слушает Windows так же, как оверлеи «нажатых клавиш» для стримов:
//   - «сырое» движение мыши (Raw Input), кнопки мыши и колёсико;
//   - состояние только тех клавиш, коды которых переданы в аргументах (бинды прыжка, перезарядки, смены оружия).
// Данные выводятся в stdout ТОЛЬКО пока активное окно — cs2.exe. Ничего не сохраняет.
//
// Протокол (строки):
//   READY                 — запущен
//   F 1|0                 — CS2 в фокусе / не в фокусе
//   M <dx> <dy>           — сумма отсчётов мыши за ~5 мс
//   B <L|R|M|4|5> <1|0>   — кнопка мыши нажата / отпущена
//   W <U|D>               — колёсико вверх / вниз
//   K <vk> <1|0>          — отслеживаемая клавиша нажата / отпущена
// Аргумент: список кодов клавиш через запятую, например "32,49,50,81".
// Завершается, когда закрывается stdin (родительская программа вышла).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class InputHelper
{
    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE
    {
        public ushort UsagePage;
        public ushort Usage;
        public uint Flags;
        public IntPtr Target;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);

    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vk);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    const int WM_INPUT = 0x00FF;
    const uint RID_INPUT = 0x10000003;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const uint RIM_TYPEMOUSE = 0;

    static TextWriter Out;
    static readonly object Lock = new object();
    static int dxAccum = 0;
    static int dyAccum = 0;
    static bool focused = false;
    static int[] watchKeys = new int[0];
    static bool[] keyDown = new bool[0];
    static uint lastFgPid = 0;
    static bool lastFgIsCs2 = false;
    static bool registrationFailed = false;

    static void RefreshRegistration(RAWINPUTDEVICE[] devices)
    {
        if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
        {
            registrationFailed = true;
            Emit("ERROR raw input " + Marshal.GetLastWin32Error());
        }
        else if (registrationFailed)
        {
            registrationFailed = false;
            Emit("READY");
        }
    }

    static void Emit(string line)
    {
        lock (Lock)
        {
            Out.Write(line);
            Out.Write('\n');
            Out.Flush();
        }
    }

    sealed class Sink : NativeWindow
    {
        public Sink()
        {
            CreateHandle(new CreateParams());
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_INPUT) HandleRawInput(m.LParam);
            base.WndProc(ref m);
        }
    }

    static void HandleRawInput(IntPtr hRaw)
    {
        uint headerSize = (uint)(8 + 2 * IntPtr.Size);
        uint size = 0;
        GetRawInputData(hRaw, RID_INPUT, IntPtr.Zero, ref size, headerSize);
        if (size == 0) return;
        IntPtr buf = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(hRaw, RID_INPUT, buf, ref size, headerSize) != size) return;
            if ((uint)Marshal.ReadInt32(buf, 0) != RIM_TYPEMOUSE) return;
            if (!focused) return;
            int o = (int)headerSize;
            ushort usFlags = (ushort)Marshal.ReadInt16(buf, o);
            ushort buttonFlags = (ushort)Marshal.ReadInt16(buf, o + 4);
            short buttonData = Marshal.ReadInt16(buf, o + 6);
            int lastX = Marshal.ReadInt32(buf, o + 12);
            if ((usFlags & 1) == 0)
            {
                Interlocked.Add(ref dxAccum, lastX);
                Interlocked.Add(ref dyAccum, Marshal.ReadInt32(buf, o + 16));
            }
            if (buttonFlags == 0) return;
            FlushMouse();
            PollKeys();
            if ((buttonFlags & 0x0001) != 0) Emit("B L 1");
            if ((buttonFlags & 0x0002) != 0) Emit("B L 0");
            if ((buttonFlags & 0x0004) != 0) Emit("B R 1");
            if ((buttonFlags & 0x0008) != 0) Emit("B R 0");
            if ((buttonFlags & 0x0010) != 0) Emit("B M 1");
            if ((buttonFlags & 0x0020) != 0) Emit("B M 0");
            if ((buttonFlags & 0x0040) != 0) Emit("B 4 1");
            if ((buttonFlags & 0x0080) != 0) Emit("B 4 0");
            if ((buttonFlags & 0x0100) != 0) Emit("B 5 1");
            if ((buttonFlags & 0x0200) != 0) Emit("B 5 0");
            if ((buttonFlags & 0x0400) != 0) Emit(buttonData > 0 ? "W U" : "W D");
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }

    static void FlushMouse()
    {
        int dx = Interlocked.Exchange(ref dxAccum, 0);
        int dy = Interlocked.Exchange(ref dyAccum, 0);
        if (dx != 0 || dy != 0) Emit("M " + dx + " " + dy);
    }

    static void PollKeys()
    {
        for (int i = 0; i < watchKeys.Length; i++)
        {
            bool down = (GetAsyncKeyState(watchKeys[i]) & 0x8000) != 0;
            if (down == keyDown[i]) continue;
            keyDown[i] = down;
            Emit("K " + watchKeys[i] + (down ? " 1" : " 0"));
        }
    }

    static bool IsCs2Foreground()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return false;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == lastFgPid) return lastFgIsCs2;
        lastFgPid = pid;
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                lastFgIsCs2 = string.Equals(p.ProcessName, "cs2", StringComparison.OrdinalIgnoreCase);
            }
        }
        catch
        {
            lastFgIsCs2 = false;
        }
        return lastFgIsCs2;
    }

    [STAThread]
    static int Main(string[] args)
    {
        Out = new StreamWriter(Console.OpenStandardOutput());
        if (args.Length > 0 && args[0] == "--tray")
        {
            RunTray(args.Length > 1 && args[1] == "en");
            return 0;
        }
        if (args.Length > 0 && args[0].Length > 0)
        {
            List<int> keys = new List<int>();
            foreach (string s in args[0].Split(','))
            {
                int vk;
                if (int.TryParse(s.Trim(), out vk) && vk > 0 && vk < 256) keys.Add(vk);
            }
            watchKeys = keys.ToArray();
            keyDown = new bool[watchKeys.Length];
        }

        Sink sink = new Sink();
        RAWINPUTDEVICE[] devices = new RAWINPUTDEVICE[1];
        devices[0].UsagePage = 0x01;
        devices[0].Usage = 0x02; // мышь
        devices[0].Flags = RIDEV_INPUTSINK;
        devices[0].Target = sink.Handle;
        if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
        {
            Emit("ERROR raw input " + Marshal.GetLastWin32Error());
            return 2;
        }

        // Проверка времени жизни NativeWindow и регистрации без ввода пользователя.
        if (Array.IndexOf(args, "--self-test") >= 0)
        {
            for (int i = 0; i < 100; i++)
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
                Application.DoEvents();
                RefreshRegistration(devices);
                if (!IsWindow(devices[0].Target) || registrationFailed)
                {
                    Emit("ERROR window lifetime test");
                    return 3;
                }
            }
            GC.KeepAlive(sink);
            sink.DestroyHandle();
            Emit("PASS window survives 100 GC cycles and registrations");
            return 0;
        }

        // Родитель закрыл stdin — выходим.
        Thread stdinWatch = new Thread(delegate ()
        {
            try { while (Console.In.Read() != -1) { } } catch { }
            Environment.Exit(0);
        });
        stdinWatch.IsBackground = true;
        stdinWatch.Start();

        int focusCounter = 0;
        Stopwatch registrationClock = Stopwatch.StartNew();
        System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        timer.Interval = 5;
        timer.Tick += delegate
        {
            if (++focusCounter >= 40) // ~200 мс
            {
                focusCounter = 0;
                bool f = IsCs2Foreground();
                if (f != focused)
                {
                    focused = f;
                    Interlocked.Exchange(ref dxAccum, 0);
                    Interlocked.Exchange(ref dyAccum, 0);
                    for (int i = 0; i < keyDown.Length; i++) keyDown[i] = false;
                    Emit(f ? "F 1" : "F 0");
                    if (f) registrationClock.Restart();
                    if (f) RefreshRegistration(devices);
                }
            }
            if (!focused) return;
            // Восстанавливаем подписку после переключений окон/устройств мыши.
            // Клавиши могут продолжать работать даже при потере потока WM_INPUT.
            if (registrationClock.ElapsedMilliseconds >= 5000)
            {
                registrationClock.Restart();
                RefreshRegistration(devices);
            }
            FlushMouse();
            PollKeys();
        };
        timer.Start();
        Emit("READY");
        Application.Run();
        // JIT может считать локальный sink мёртвым уже после чтения Handle.
        // Без KeepAlive финализатор NativeWindow уничтожает HWND во время Run(),
        // после чего RegisterRawInputDevices получает ERROR_INVALID_PARAMETER (87).
        GC.KeepAlive(sink);
        timer.Stop();
        sink.DestroyHandle();
        return 0;
    }

    static void RunTray(bool english)
    {
        using (Control dispatch = new Control())
        using (ContextMenuStrip menu = new ContextMenuStrip())
        using (NotifyIcon icon = new NotifyIcon())
        using (Stream iconData = typeof(InputHelper).Assembly.GetManifestResourceStream("CS2Tasks.ico"))
        using (System.Drawing.Icon trayIcon = new System.Drawing.Icon(iconData, SystemInformation.SmallIconSize))
        {
            IntPtr handle = dispatch.Handle;
            menu.Items.Add(english ? "Open dashboard" : "Открыть панель", null, delegate { Emit("PANEL"); });
            menu.Items.Add(english ? "Open overlay" : "Открыть оверлей", null, delegate { Emit("OVERLAY"); });
            ToolStripItem update = menu.Items.Add(english ? "Open release on GitHub" : "Открыть релиз на GitHub", null, delegate { Emit("UPDATE"); });
            update.Visible = false;
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(english ? "Exit" : "Выйти", null, delegate { Emit("EXIT"); });
            icon.Icon = trayIcon;
            icon.Text = "CS2 Tasks";
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { Emit("PANEL"); };
            icon.BalloonTipClicked += delegate { Emit("UPDATE"); };
            icon.Visible = true;
            Thread parent = new Thread(delegate()
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        if (!line.StartsWith("UPDATE ")) continue;
                        string version = line.Substring(7);
                        dispatch.BeginInvoke(new MethodInvoker(delegate
                        {
                            update.Visible = true;
                            icon.ShowBalloonTip(5000, "CS2 Tasks", (english ? "New version available: " : "Доступна новая версия: ") + version, ToolTipIcon.Info);
                        }));
                    }
                }
                finally
                {
                    try { dispatch.BeginInvoke(new MethodInvoker(Application.ExitThread)); }
                    catch (InvalidOperationException) { }
                }
            });
            parent.IsBackground = true;
            parent.Start();
            Application.Run();
            icon.Visible = false;
        }
    }
}
