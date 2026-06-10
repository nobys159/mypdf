$exePath = Join-Path $PSScriptRoot '..\dist\win-unpacked\mypdf.exe'
if (-not (Test-Path $exePath)) {
  Write-Output "EXE_NOT_FOUND: $exePath"
  exit 2
}
New-Item -Path 'HKCU:\Software\Classes\mypdf' -Force | Out-Null
New-Item -Path 'HKCU:\Software\Classes\mypdf\shell\open\command' -Force | Out-Null
$cmd = '"' + $exePath + '" "%1"'
Set-ItemProperty -Path 'HKCU:\Software\Classes\mypdf\shell\open\command' -Name '(default)' -Value $cmd
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids' -Name 'mypdf' -Value '' -PropertyType String -Force | Out-Null
Write-Output "REGISTERED: $exePath"