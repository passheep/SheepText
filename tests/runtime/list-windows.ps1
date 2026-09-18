# List visible top-level window titles of Electron processes (ASCII only for PS 5.1 safety)
# Writes results as UTF-8 via .NET to avoid console codepage mangling.
param([string]$OutputPath = ".runtime-user-data/window-titles.txt")
$signature = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
Add-Type -TypeDefinition $signature
$targets = (Get-Process electron -ErrorAction SilentlyContinue).Id
$titles = New-Object System.Collections.ArrayList
$callback = [WinEnum+EnumProc]{
  param($hWnd, $lParam)
  $owner = 0
  [WinEnum]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($targets -contains $owner -and [WinEnum]::IsWindowVisible($hWnd)) {
    $len = [WinEnum]::GetWindowTextLength($hWnd)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [WinEnum]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
      [void]$titles.Add($sb.ToString())
    }
  }
  return $true
}
[WinEnum]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
$sorted = $titles | Sort-Object
[System.IO.File]::WriteAllLines((Resolve-Path -LiteralPath (Split-Path -Parent $OutputPath)).Path + "\" + (Split-Path -Leaf $OutputPath), $sorted, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("windows=" + $sorted.Count)