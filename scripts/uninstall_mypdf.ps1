$installPath = Join-Path $PSScriptRoot '..\dist\win-unpacked'
$installPath = [System.IO.Path]::GetFullPath($installPath)
Write-Output "InstallPath=$installPath"

# Stop running processes named mypdf
$procs = Get-Process -Name mypdf -ErrorAction SilentlyContinue
if ($procs) {
  $procs | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Write-Output "StoppedProcesses"
} else {
  Write-Output "NoRunningProcesses"
}

# Remove install folder
if (Test-Path $installPath) {
  try {
    Remove-Item -LiteralPath $installPath -Recurse -Force -ErrorAction Stop
    Write-Output "RemovedDir"
  } catch {
    Write-Output "RemoveDirFailed: $($_.Exception.Message)"
  }
} else {
  Write-Output "DirNotFound"
}

# Remove HKCU uninstall key
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\mypdf'
if (Test-Path $uninstallKey) {
  Remove-Item -Path $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "RemovedUninstallKey"
} else {
  Write-Output "UninstallKeyNotFound"
}

# Remove ProgID class
$classKey = 'HKCU:\Software\Classes\mypdf'
if (Test-Path $classKey) {
  Remove-Item -Path $classKey -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "RemovedClassKey"
} else {
  Write-Output "ClassKeyNotFound"
}

# Remove OpenWithProgids entry
$openWith = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids'
try {
  Remove-ItemProperty -Path $openWith -Name 'mypdf' -ErrorAction SilentlyContinue
  Write-Output "RemovedOpenWithProgids"
} catch {
  Write-Output "OpenWithProgidsNotFound"
}

# Remove argv log
$log = Join-Path $env:TEMP 'mypdf-argv.log'
if (Test-Path $log) { Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue; Write-Output "RemovedLog" } else { Write-Output "LogNotFound" }

Write-Output "CLEANUP_DONE"