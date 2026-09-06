using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

// Dead-man's switch: while privacy mode blanks + locks this machine, the host app sends a
// heartbeat line every ~2s. If we go 8s without hearing anything from it (host crashed,
// hung, or the remote session dropped without a clean teardown), restore the screen and
// unlock input ourselves — never leave the user staring at a black, frozen desktop.
long lastLineTicks = DateTime.UtcNow.Ticks;
using var deadMan = new Timer(
    _ =>
    {
        var idle = DateTime.UtcNow - new DateTime(Interlocked.Read(ref lastLineTicks), DateTimeKind.Utc);
        if (Privacy.IsActive && idle.TotalSeconds > 8) Privacy.SetActive(false);
    },
    null,
    1000,
    1000
);

while (Console.ReadLine() is { } line)
{
    Interlocked.Exchange(ref lastLineTicks, DateTime.UtcNow.Ticks);
    try
    {
        var command = JsonSerializer.Deserialize(line, AgentJsonContext.Default.ControlCommand);
        if (command is null) continue;
        if (command.Type == "privacy" && command.Down is { } privacyOn) Privacy.SetActive(privacyOn);
        else if (command.Type == "privacy-ping") { /* heartbeat only */ }
        else Input.Apply(command);
    }
    catch (JsonException)
    {
        // Ignore malformed IPC messages.
    }
}

// The host process (Electron) closing our stdin — normal exit, crash, or a forced kill that still
// lets the pipe close — is the last line of defense: whatever happens upstream, never leave the
// local machine blanked and blocked. (Ctrl+Alt+Del also always escapes BlockInput; that's a Windows
// guarantee, not something we implement.)
Privacy.SetActive(false);

[JsonSourceGenerationOptions(PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(ControlCommand))]
partial class AgentJsonContext : JsonSerializerContext;

record ControlCommand(
    string Type,
    double? X,
    double? Y,
    double? Dx,
    double? Dy,
    string? Button,
    string? Key,
    string? Code,
    bool? Down,
    string[]? Keys);

/// <summary>
/// "Gizlilik modu": blanks the local physical monitor(s) and blocks local keyboard/mouse input
/// while a remote session is active, so a bystander at the host machine can't see or interfere.
///
/// Two Win32 mechanisms, both well-precedented in remote-support tools:
///  - SC_MONITORPOWER turns the physical display off at the driver level. Windows keeps composing
///    the desktop regardless (this is what lets remote screen capture keep working with the local
///    monitor "off" — no monitor attached at all is a fully supported capture scenario since Win8).
///  - BlockInput blocks local hardware input for the whole session. It does NOT block SendInput
///    calls made by THIS SAME PROCESS, which is exactly how Input.Apply's synthetic mouse/keyboard
///    events (driven by the remote viewer) still get through — that's why privacy mode and remote
///    control both live in this one process rather than two.
/// Windows itself guarantees Ctrl+Alt+Del is never swallowed by BlockInput, so there is always a
/// physical way out even if every safety net below somehow fails.
/// </summary>
static class Privacy
{
    private static bool _active;
    private static Timer? _watchdog;
    private static readonly object _gate = new();

    public static bool IsActive
    {
        get { lock (_gate) return _active; }
    }

    public static void SetActive(bool on)
    {
        lock (_gate)
        {
            if (on == _active) return;
            _active = on;

            if (on)
            {
                BlockInput(true);
                SetMonitorPower(off: true);
                // Belt-and-suspenders: re-assert monitor-off periodically. Nothing in this process
                // should wake it, but a driver/power-management quirk waking the display shouldn't
                // leave it lit for the rest of the session.
                _watchdog = new Timer(_ => SetMonitorPower(off: true), null, 2000, 2000);
            }
            else
            {
                _watchdog?.Dispose();
                _watchdog = null;
                SetMonitorPower(off: false);
                BlockInput(false);
            }
        }
    }

    private static void SetMonitorPower(bool off)
    {
        const uint WM_SYSCOMMAND = 0x0112;
        const int SC_MONITORPOWER = 0xF170;
        const int HWND_BROADCAST = 0xFFFF;
        PostMessage((nint)HWND_BROADCAST, WM_SYSCOMMAND, (nint)SC_MONITORPOWER, off ? 2 : -1);
    }

    [DllImport("user32.dll")] private static extern bool BlockInput(bool block);
    [DllImport("user32.dll")] private static extern bool PostMessage(nint hWnd, uint msg, nint wParam, nint lParam);
}

static class Input
{
    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;
    private const uint MouseMove = 0x0001;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint MouseRightDown = 0x0008;
    private const uint MouseRightUp = 0x0010;
    private const uint MouseMiddleDown = 0x0020;
    private const uint MouseMiddleUp = 0x0040;
    private const uint MouseWheel = 0x0800;
    private const uint MouseHWheel = 0x1000;
    private const uint MouseAbsolute = 0x8000;
    private const uint MouseVirtualDesktop = 0x4000;
    private const uint KeyUp = 0x0002;

    public static void Apply(ControlCommand command)
    {
        switch (command.Type)
        {
            case "pointer" when command.X is >= 0 and <= 1 && command.Y is >= 0 and <= 1:
                Move(command.X.Value, command.Y.Value);
                if (command.Button is { Length: > 0 } button && command.Down is { } down) Click(button, down);
                break;

            case "scroll" when command.X is >= 0 and <= 1 && command.Y is >= 0 and <= 1:
                Move(command.X.Value, command.Y.Value);
                if (command.Dy is { } dy && dy != 0) Wheel(MouseWheel, (int)Math.Round(-dy * 2));
                if (command.Dx is { } dx && dx != 0) Wheel(MouseHWheel, (int)Math.Round(dx * 2));
                break;

            case "key" when (command.Code is { Length: > 0 } || command.Key is { Length: > 0 }) && command.Down is { } keyDown:
                var vk = ToVirtualKey(command.Key, command.Code);
                if (vk != 0) SendKey(vk, keyDown);
                break;

            case "combo" when command.Keys is { Length: > 0 } keys:
                var codes = Array.ConvertAll(keys, k => ToVirtualKey(k, null));
                foreach (var code in codes) if (code != 0) SendKey(code, true);
                for (var i = codes.Length - 1; i >= 0; i--) if (codes[i] != 0) SendKey(codes[i], false);
                break;
        }
    }

    private static void Move(double x, double y) => Send(new INPUT
    {
        Type = InputMouse,
        Union = new InputUnion
        {
            Mouse = new MOUSEINPUT
            {
                Dx = (int)(x * 65535),
                Dy = (int)(y * 65535),
                Flags = MouseMove | MouseAbsolute | MouseVirtualDesktop
            }
        }
    });

    private static void Click(string button, bool down)
    {
        var flag = button switch
        {
            "left" => down ? MouseLeftDown : MouseLeftUp,
            "right" => down ? MouseRightDown : MouseRightUp,
            "middle" => down ? MouseMiddleDown : MouseMiddleUp,
            _ => 0u
        };
        if (flag != 0) Send(new INPUT { Type = InputMouse, Union = new InputUnion { Mouse = new MOUSEINPUT { Flags = flag } } });
    }

    private static void Wheel(uint flag, int amount) => Send(new INPUT
    {
        Type = InputMouse,
        Union = new InputUnion { Mouse = new MOUSEINPUT { MouseData = unchecked((uint)(amount * 120)), Flags = flag } }
    });

    private static void SendKey(ushort virtualKey, bool down) => Send(new INPUT
    {
        Type = InputKeyboard,
        Union = new InputUnion { Keyboard = new KEYBDINPUT { VirtualKey = virtualKey, Flags = down ? 0 : KeyUp } }
    });

    private static ushort ToVirtualKey(string? key, string? code)
    {
        if (!string.IsNullOrEmpty(code))
        {
            if (code.StartsWith("Key", StringComparison.Ordinal) && code.Length == 4) return (ushort)code[3];
            if (code.StartsWith("Digit", StringComparison.Ordinal) && code.Length == 6) return (ushort)code[5];
            if (code.StartsWith("F", StringComparison.Ordinal) && int.TryParse(code.AsSpan(1), out var fn) && fn is >= 1 and <= 24)
                return (ushort)(0x70 + fn - 1);
        }

        var named = key switch
        {
            "Enter" => 0x0D, "Backspace" => 0x08, "Tab" => 0x09, "Escape" => 0x1B, " " or "Spacebar" => 0x20,
            "ArrowLeft" => 0x25, "ArrowUp" => 0x26, "ArrowRight" => 0x27, "ArrowDown" => 0x28,
            "Delete" => 0x2E, "Insert" => 0x2D, "Home" => 0x24, "End" => 0x23, "PageUp" => 0x21, "PageDown" => 0x22,
            "Control" => 0x11, "Alt" => 0x12, "Shift" => 0x10, "Meta" or "OS" => 0x5B, "CapsLock" => 0x14,
            "ContextMenu" => 0x5D, "PrintScreen" => 0x2C,
            _ => 0
        };
        if (named != 0) return (ushort)named;

        if (key is { Length: 1 })
        {
            var scan = VkKeyScan(key[0]);
            return scan < 0 ? (ushort)0 : (ushort)(scan & 0xFF);
        }
        return 0;
    }

    private static void Send(INPUT input) => SendInput(1, [input], Marshal.SizeOf<INPUT>());

    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern short VkKeyScan(char character);

    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint Type; public InputUnion Union; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT Mouse; [FieldOffset(0)] public KEYBDINPUT Keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int Dx; public int Dy; public uint MouseData; public uint Flags; public uint Time; public nint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort VirtualKey; public ushort ScanCode; public uint Flags; public uint Time; public nint ExtraInfo; }
}
