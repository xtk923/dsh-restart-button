<#
  raise-window.ps1 — report, and optionally raise, the main window of one process.

  Why this exists: a replaced DSH comes back without a visible window. The
  relaunched shell reaches `enterWorkspace()` and calls `window.show()`, and the
  helper confirms the Web host is up — but nothing appears until the user
  double-clicks the tray. A process started by a background process (the
  restart helper, not Explorer) is not the foreground process, so Windows is
  free to leave its first window unraised, and nothing in the app re-asserts it.

  So the helper asks this script what the replacement's windows actually look
  like and then shows and raises the main one. The JSON it prints is also the
  diagnostic: "no top-level window at all", "one hidden window" and "one
  visible window that was simply behind something else" are three different
  bugs, and they are indistinguishable from the outside without asking.

  Called as:
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
      -File raise-window.ps1 -ProcessId 1234 [-Raise]
#>
param(
	[Parameter(Mandatory = $true)][int]$ProcessId,
	[switch]$Raise,
	# Test hook: hide the main window first, so the raise path can be driven
	# against a window this script hid rather than a real app that starts hidden.
	[switch]$Hide
)

$ErrorActionPreference = 'Stop'

# The caller is a Node process reading this script's stdout as UTF-8. Windows
# PowerShell's default console encoding is the ANSI code page, so without this
# a window title that is not ASCII arrives mangled — and "which window did the
# probe find?" is exactly the question this report exists to answer. Measured on
# the real app: the Chinese session title came through as mojibake.
try {
	[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
	$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
	# An older host without the constructor falls back to whatever it has; the
	# numeric fields the helper decides on are ASCII either way.
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class DshWindowFinder {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

  public const int SW_HIDE = 0;
  public const int SW_SHOW = 5;
  public const int SW_RESTORE = 9;

  public class Info {
    public long Handle;
    public bool Visible;
    public bool Minimized;
    public int Width;
    public int Height;
    public string Title;
    public string Class;
    public long Area { get { return (long)Width * (long)Height; } }
  }

  /// Every top-level window owned by the pid, visible or not.
  public static List<Info> List(uint target) {
    var found = new List<Info>();
    EnumWindows(delegate(IntPtr handle, IntPtr state) {
      uint owner;
      GetWindowThreadProcessId(handle, out owner);
      if (owner != target) return true;
      RECT rect;
      GetWindowRect(handle, out rect);
      var title = new StringBuilder(512);
      GetWindowTextW(handle, title, title.Capacity);
      var cls = new StringBuilder(256);
      GetClassNameW(handle, cls, cls.Capacity);
      var info = new Info();
      info.Handle = handle.ToInt64();
      info.Visible = IsWindowVisible(handle);
      info.Minimized = IsIconic(handle);
      info.Width = rect.Right - rect.Left;
      info.Height = rect.Bottom - rect.Top;
      info.Title = title.ToString();
      info.Class = cls.ToString();
      found.Add(info);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /// Whether the handle is a real, still-existing window.
  public static bool Exists(long handle) {
    return IsWindow(new IntPtr(handle));
  }

  /// Show, restore and raise one window.
  public static bool Show(long handle) {
    var window = new IntPtr(handle);
    if (!IsWindow(window)) return false;
    if (IsIconic(window)) ShowWindowAsync(window, SW_RESTORE);
    ShowWindowAsync(window, SW_SHOW);
    BringWindowToTop(window);
    SetForegroundWindow(window);
    return true;
  }

  /// Hide one window; the test hook's only operation.
  public static bool Hide(long handle) {
    var window = new IntPtr(handle);
    if (!IsWindow(window)) return false;
    ShowWindowAsync(window, SW_HIDE);
    return true;
  }
}
'@

$windows = @()
$process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if ($null -ne $process) {
	$windows = @([DshWindowFinder]::List([uint32]$ProcessId))
}

# The application's own window class; the largest one is the window a user
# means by "the interface" — the update overlays are small and skip the taskbar.
$candidates = @($windows | Where-Object { $_.Width -gt 0 -and $_.Height -gt 0 })
$main = $candidates | Where-Object { $_.Class -eq 'Chrome_WidgetWin_1' } | Sort-Object Area -Descending | Select-Object -First 1
if ($null -eq $main) { $main = $candidates | Sort-Object Area -Descending | Select-Object -First 1 }

# One action at most, then a settle pause: ShowWindowAsync only queues the call,
# so reading visibility immediately after it reports the previous state.
$raised = $false
$hidden = $false
if ($null -ne $main) {
	if ($Hide) {
		$hidden = [DshWindowFinder]::Hide([int64]$main.Handle)
		Start-Sleep -Milliseconds 400
	} elseif ($Raise) {
		$raised = [DshWindowFinder]::Show([int64]$main.Handle)
		Start-Sleep -Milliseconds 400
	}
}
$visibleAfter = if ($null -eq $main) { $false } else { [DshWindowFinder]::IsWindowVisible([IntPtr][int64]$main.Handle) }

$result = [ordered]@{
	pid = $ProcessId
	alive = ($null -ne $process)
	windowCount = $windows.Count
	main = if ($null -eq $main) { $null } else { [ordered]@{
		handle = $main.Handle
		class = $main.Class
		title = $main.Title
		width = $main.Width
		height = $main.Height
		visible = $main.Visible
		minimized = $main.Minimized
	} }
	raised = $raised
	hidden = $hidden
	visibleAfter = $visibleAfter
}
$result | ConvertTo-Json -Depth 5 -Compress
