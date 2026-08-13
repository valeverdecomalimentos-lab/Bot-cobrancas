$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$compiledApp = Get-ChildItem (Join-Path $repoRoot 'dist\win-unpacked') -Filter '*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# Este atalho pertence ao repositorio: quando o Electron local existe, ele deve
# abrir os arquivos-fonte atuais. O pacote em dist pode ser de uma compilacao
# anterior e fica somente como alternativa para maquinas sem node_modules.
if (Test-Path $electronExe) {
    Start-Process -FilePath $electronExe -ArgumentList '.' -WorkingDirectory $repoRoot
    Write-Host 'Vale Verde Dashboard iniciado em modo de desenvolvimento.'
    exit 0
}

if ($compiledApp) {
    Start-Process -FilePath $compiledApp.FullName -WorkingDirectory $repoRoot
    Write-Host 'Vale Verde Dashboard iniciado pelo pacote compilado.'
    exit 0
}

throw 'Dependencias nao encontradas. Execute npm install antes de iniciar o painel.'
