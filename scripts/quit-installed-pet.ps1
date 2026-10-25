param(
  [string]$Executable = 'E:\DragonBot\dragon-pet\龙娘桌宠.exe',
  [switch]$Execute,
  [int]$ExitTimeoutSeconds = 15
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Test-TrayAncestor([System.Windows.Automation.AutomationElement]$Element) {
  $petTrayNode = $Element
  for ($petTrayDepth = 0; $petTrayDepth -lt 16 -and $null -ne $petTrayNode; $petTrayDepth++) {
    try {
      if ($petTrayNode.Current.ClassName -match 'Shell_TrayWnd|Shell_SecondaryTrayWnd|NotifyIconOverflowWindow|TopLevelWindowForOverflowXamlIsland|XamlExplorerHostIslandWindow') { return $true }
      $petTrayNode = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($petTrayNode)
    } catch { return $false }
  }
  return $false
}

function Find-TrayButton([string[]]$Names) {
  foreach ($petTrayName in $Names) {
    $petTrayCondition = [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $petTrayName),
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    )
    $petTrayCandidates = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $petTrayCondition)
    foreach ($petTrayCandidate in $petTrayCandidates) {
      try { if (-not $petTrayCandidate.Current.IsOffscreen -and (Test-TrayAncestor $petTrayCandidate)) { return $petTrayCandidate } } catch { }
    }
  }
  return $null
}

$petResolvedExecutable = [System.IO.Path]::GetFullPath($Executable)
$petInstalledProcesses = @(Get-CimInstance Win32_Process -Filter "Name='龙娘桌宠.exe'" | Where-Object { $_.ExecutablePath -eq $petResolvedExecutable })
$petInstalledIds = @($petInstalledProcesses | ForEach-Object { [int]$_.ProcessId })
$petMainProcesses = @($petInstalledProcesses | Where-Object { $petInstalledIds -notcontains [int]$_.ParentProcessId })
if ($petInstalledProcesses.Count -eq 0) { [pscustomobject]@{Running=$false;Executed=$false;ForcedTermination=$false} | ConvertTo-Json; return }
if ($petMainProcesses.Count -ne 1) { throw 'Cannot identify one installed-app main process; no action performed.' }
$petMainId = [int]$petMainProcesses[0].ProcessId
$petTrayButton = Find-TrayButton @('龙娘桌宠')
if (-not $Execute) {
  [pscustomobject]@{Running=$true;MainProcessId=$petMainId;Executable=$petResolvedExecutable;TrayIconCurrentlyVisible=($null -ne $petTrayButton);Executed=$false;ExitMethod='Native tray context menu → 退出 → app.quit (requires explicit -Execute)';ActiveTaskState='not inspected';ForcedTermination=$false} | ConvertTo-Json
  return
}

# This is the only execution branch. It does not use CloseMainWindow or Kill.
if ($null -eq $petTrayButton) {
  $petOverflowButton = Find-TrayButton @('显示隐藏的图标','显示隐藏图标','隐藏的图标','Show hidden icons')
  if ($null -eq $petOverflowButton) { throw 'Pet tray icon and hidden-icons button are unavailable; no quit action performed.' }
  $petOverflowInvoke = [System.Windows.Automation.InvokePattern]$petOverflowButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $petOverflowInvoke.Invoke()
  $petTrayDeadline = [DateTime]::UtcNow.AddSeconds(4)
  while ($null -eq $petTrayButton -and [DateTime]::UtcNow -lt $petTrayDeadline) { Start-Sleep -Milliseconds 150; $petTrayButton = Find-TrayButton @('龙娘桌宠') }
}
if ($null -eq $petTrayButton) { throw 'Pet tray icon was not exposed; no quit action performed.' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetTrayQuitMouse {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
}
'@
$petOldCursor = [PetTrayQuitMouse+Point]::new()
[void][PetTrayQuitMouse]::GetCursorPos([ref]$petOldCursor)
try {
  $petTrayPoint = $petTrayButton.GetClickablePoint()
  [void][PetTrayQuitMouse]::SetCursorPos([int]$petTrayPoint.X,[int]$petTrayPoint.Y)
  [PetTrayQuitMouse]::mouse_event(8,0,0,0,[UIntPtr]::Zero)
  [PetTrayQuitMouse]::mouse_event(16,0,0,0,[UIntPtr]::Zero)
  $petExitCondition = [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'退出'),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::MenuItem),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$petMainId)
  )
  $petExitItem = $null
  $petExitMenuDeadline = [DateTime]::UtcNow.AddSeconds(4)
  while ($null -eq $petExitItem -and [DateTime]::UtcNow -lt $petExitMenuDeadline) { $petExitItem = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$petExitCondition); if ($null -eq $petExitItem) { Start-Sleep -Milliseconds 100 } }
  if ($null -eq $petExitItem -or -not $petExitItem.Current.IsEnabled) { throw 'No enabled native 退出 item belonging to the installed process; no quit action performed.' }
  $petExitInvoke = [System.Windows.Automation.InvokePattern]$petExitItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $petExitInvoke.Invoke()
} finally { [void][PetTrayQuitMouse]::SetCursorPos($petOldCursor.X,$petOldCursor.Y) }

$petQuitDeadline = [DateTime]::UtcNow.AddSeconds($ExitTimeoutSeconds)
while ((Get-Process -Id $petMainId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $petQuitDeadline) { Start-Sleep -Milliseconds 150 }
if (Get-Process -Id $petMainId -ErrorAction SilentlyContinue) { throw 'Native quit was invoked but the main process remains alive; no forced termination attempted.' }
[pscustomobject]@{Running=$false;MainProcessId=$petMainId;Executed=$true;ExitMethod='Native tray 退出';ForcedTermination=$false} | ConvertTo-Json
