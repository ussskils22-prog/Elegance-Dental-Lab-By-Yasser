# Barcode capture for the scan agent (US key mapping - works with the Arabic keyboard active).
#  - stdout: "SCAN:<code>" per scan, "HOOK_READY" once, "REHOOK" when the hook is renewed
#  - stdin (from agent.js, UTF-8): "TIP|ok|text", "TIP|warn|text", "TIP|err|text", "TIP|state-ok|text"
#  - Tray icon next to the clock shows the station state; scan results pop up as notifications.
#  - Windows can silently drop a low-level hook; it is re-installed every 2 minutes.
#  - When agent.js exits (stdin closes) this process exits too.
param([string]$Label = 'Scan')

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public sealed class UsBarcodeHook {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_SYSKEYDOWN = 0x0104;
  private const int VK_RETURN = 0x0D;
  private const int MAX_GAP_MS = 140;

  private static IntPtr _hook = IntPtr.Zero;
  private static LowLevelKeyboardProc _proc = HookProc;
  private static readonly StringBuilder Buf = new StringBuilder(64);
  private static long _lastMs = 0;
  private static NotifyIcon _tray;
  private static Control _ui;
  private static string _label = "Scan";

  private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")]
  private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetModuleHandle(string lpModuleName);

  [StructLayout(LayoutKind.Sequential)]
  private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

  private static char FromVk(uint vk) {
    if (vk >= 0x30 && vk <= 0x39) return (char)vk;
    if (vk >= 0x41 && vk <= 0x5A) return (char)vk;
    if (vk >= 0x60 && vk <= 0x69) return (char)('0' + (vk - 0x60));
    if (vk == 0xBD || vk == 0x6D) return '-';
    if (vk == 0xBE) return '.';
    return '\0';
  }

  private static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam) {
    try {
      if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN)) {
        var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        long now = DateTime.UtcNow.Ticks / 10000;
        if (_lastMs > 0 && now - _lastMs > MAX_GAP_MS) Buf.Clear();
        _lastMs = now;
        if (info.vkCode == VK_RETURN) {
          if (Buf.Length >= 6) { Console.WriteLine("SCAN:" + Buf.ToString()); Console.Out.Flush(); }
          Buf.Clear();
        } else {
          char ch = FromVk(info.vkCode);
          if (ch != '\0') Buf.Append(ch);
        }
      }
    } catch { }
    return CallNextHookEx(_hook, nCode, wParam, lParam);
  }

  private static void InstallHook() {
    if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
    using (Process cur = Process.GetCurrentProcess())
    using (ProcessModule mod = cur.MainModule) {
      _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(mod.ModuleName), 0);
    }
    if (_hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }

  private static string Clip(string s, int n) { return s.Length <= n ? s : s.Substring(0, n - 3) + "..."; }

  private static void Handle(string line) {
    string[] p = line.Split(new char[] { '|' }, 3);
    if (p.Length < 3 || p[0] != "TIP") return;
    string kind = p[1], text = p[2];
    Icon icon = kind == "err" ? SystemIcons.Error : kind == "warn" ? SystemIcons.Warning : SystemIcons.Information;
    _tray.Icon = icon;
    _tray.Text = Clip(_label + " - " + text, 63);
    if (kind == "state-ok") return;
    ToolTipIcon ti = kind == "err" ? ToolTipIcon.Error : kind == "warn" ? ToolTipIcon.Warning : ToolTipIcon.Info;
    _tray.ShowBalloonTip(kind == "ok" ? 2000 : 6000, _label, text, ti);
  }

  private static void ReadStdin() {
    string line;
    try {
      while ((line = Console.In.ReadLine()) != null) {
        string l = line;
        _ui.BeginInvoke((MethodInvoker)delegate { try { Handle(l); } catch { } });
      }
    } catch { }
    // agent.js is gone: remove the icon and exit
    _ui.BeginInvoke((MethodInvoker)delegate { _tray.Visible = false; Application.Exit(); });
  }

  public static void Run(string label) {
    _label = string.IsNullOrEmpty(label) ? "Scan" : label;
    _ui = new Control();
    _ui.CreateControl();
    IntPtr force = _ui.Handle;
    _tray = new NotifyIcon();
    _tray.Icon = SystemIcons.Information;
    _tray.Text = Clip(_label + " - ready", 63);
    _tray.Visible = true;

    InstallHook();
    Console.WriteLine("HOOK_READY");
    Console.Out.Flush();

    var timer = new System.Windows.Forms.Timer();
    timer.Interval = 120000;
    timer.Tick += delegate {
      try { InstallHook(); Console.WriteLine("REHOOK"); Console.Out.Flush(); } catch { }
    };
    timer.Start();

    var t = new Thread(ReadStdin);
    t.IsBackground = true;
    t.Start();
    Application.Run();
    if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
  }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

[UsBarcodeHook]::Run($Label)
