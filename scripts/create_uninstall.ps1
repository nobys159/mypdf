$installDir = Resolve-Path -Path '.\dist\win-unpacked' -ErrorAction Stop
$installPath = $installDir.Path
$exePath = Join-Path $installPath 'mypdf.exe'
$keyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\mypdf'
New-Item -Path $keyPath -Force | Out-Null
Set-ItemProperty -Path $keyPath -Name 'DisplayName' -Value 'mypdf'
Set-ItemProperty -Path $keyPath -Name 'DisplayVersion' -Value '0.1.0'
Set-ItemProperty -Path $keyPath -Name 'Publisher' -Value 'nobys'
Set-ItemProperty -Path $keyPath -Name 'InstallLocation' -Value $installPath
Set-ItemProperty -Path $keyPath -Name 'DisplayIcon' -Value $exePath
$uninstallCmd = 'cmd /c rmdir /s /q "' + $installPath + '"'
Set-ItemProperty -Path $keyPath -Name 'UninstallString' -Value $uninstallCmd
Set-ItemProperty -Path $keyPath -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $keyPath -Name 'NoRepair' -Value 1 -Type DWord
Write-Output "UNINSTALL_KEY_CREATED: $keyPath"