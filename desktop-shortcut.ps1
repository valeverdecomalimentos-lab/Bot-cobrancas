$WshShell = New-Object -ComObject WScript.Shell
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'Vale Verde Dashboard.lnk'
$targetPath = Join-Path (Get-Location) 'start-dashboard.bat'
$shortcut = $WshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = (Get-Location).Path
$shortcut.IconLocation = Join-Path (Get-Location) 'build\icon.ico'
$shortcut.Description = 'Abrir o dashboard da Vale Verde'
$shortcut.Save()
Write-Host "Atalho criado em $desktopPath"
