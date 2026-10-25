// Background mouse button notifications for the visible quick bubble only.
// No keyboard registration, mouse coordinates on movement, hooks, or input suppression.
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class RawMouseProgram
{
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    [STAThread]
    private static int Main()
    {
        try
        {
            try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
            catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
            using (MouseWindow window = new MouseWindow())
            {
                Console.WriteLine("{\"type\":\"ready\"}");
                Console.Out.Flush();
                // Closing the parent's pipe also ends this process if the parent crashes.
                Thread input = new Thread(delegate()
                {
                    try { while (Console.ReadLine() != null) { } } catch { }
                    window.RequestClose();
                });
                input.IsBackground = true;
                input.Start();
                Application.Run();
            }
            return 0;
        }
        catch
        {
            Console.Error.WriteLine("mouse-helper-unavailable");
            return 1;
        }
    }

    private sealed class MouseWindow : NativeWindow, IDisposable
    {
        private const int WM_INPUT = 0x00FF, WM_CLOSE = 0x0010;
        private const uint RID_INPUT = 0x10000003, RIDEV_INPUTSINK = 0x100, RIDEV_REMOVE = 1;
        private readonly uint headerSize = (uint)Marshal.SizeOf(typeof(RawInputHeader));
        private readonly IntPtr buffer = Marshal.AllocHGlobal(256);
        private bool disposed;

        internal MouseWindow()
        {
            CreateParams parameters = new CreateParams();
            parameters.Caption = "DragonPet mouse button receiver";
            parameters.Parent = new IntPtr(-3); // HWND_MESSAGE: never a visible desktop window.
            CreateHandle(parameters);
            RawInputDevice[] devices = { new RawInputDevice { UsagePage = 1, Usage = 2, Flags = RIDEV_INPUTSINK, Target = Handle } };
            if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RawInputDevice))))
                throw new Win32Exception();
        }

        internal void RequestClose() { PostMessage(Handle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WM_CLOSE)
            {
                Dispose();
                Application.ExitThread();
                return;
            }
            if (message.Msg == WM_INPUT)
            {
                uint length = 256;
                uint received = GetRawInputData(message.LParam, RID_INPUT, buffer, ref length, headerSize);
                if (received != uint.MaxValue && received >= headerSize + 8 && Marshal.ReadInt32(buffer) == 0)
                {
                    // RAWMOUSE contains usFlags, alignment, then the button flags union.
                    ushort flags = (ushort)Marshal.ReadInt16(buffer, (int)headerSize + 4);
                    if ((flags & 0x155) != 0)
                    {
                        Point point;
                        if (GetCursorPos(out point))
                        {
                            if ((flags & 0x001) != 0) Emit("left", point);
                            if ((flags & 0x004) != 0) Emit("right", point);
                            if ((flags & 0x010) != 0) Emit("middle", point);
                            if ((flags & 0x040) != 0) Emit("x1", point);
                            if ((flags & 0x100) != 0) Emit("x2", point);
                        }
                    }
                }
            }
            // Raw input is observational; ordinary Windows input continues unchanged.
            base.WndProc(ref message);
        }

        private static void Emit(string button, Point point)
        {
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "{{\"type\":\"mouse-down\",\"button\":\"{0}\",\"x\":{1},\"y\":{2}}}", button, point.X, point.Y));
            Console.Out.Flush();
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            RawInputDevice[] devices = { new RawInputDevice { UsagePage = 1, Usage = 2, Flags = RIDEV_REMOVE, Target = IntPtr.Zero } };
            RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RawInputDevice)));
            if (Handle != IntPtr.Zero) DestroyHandle();
            Marshal.FreeHGlobal(buffer);
        }

        [StructLayout(LayoutKind.Sequential)] private struct RawInputDevice { public ushort UsagePage, Usage; public uint Flags; public IntPtr Target; }
        [StructLayout(LayoutKind.Sequential)] private struct RawInputHeader { public uint Type, Size; public IntPtr Device, WParam; }
        [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
        [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterRawInputDevices(RawInputDevice[] devices, uint count, uint size);
        [DllImport("user32.dll")] private static extern uint GetRawInputData(IntPtr input, uint command, IntPtr data, ref uint size, uint headerSize);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    }
}
