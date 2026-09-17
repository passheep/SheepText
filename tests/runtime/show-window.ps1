Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SheepTestWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'no-window'; exit 1 }
[SheepTestWindow]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 300
[SheepTestWindow]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Write-Output "restored pid=$($p.Id) hwnd=$($p.MainWindowHandle)"
