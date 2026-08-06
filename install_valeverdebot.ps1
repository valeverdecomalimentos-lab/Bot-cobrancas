# install_valeverdebot.ps1
# Tenta instalar Node (winget -> choco -> instruir manual), depois roda npm install e inicia
$projectPath = "C:\Users\Lenovo\Documents\botcobra\ValeVerdeBot"

function Install-Node {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --silent
    return $true
  }
  if (Get-Command choco -ErrorAction SilentlyContinue) {
    choco install nodejs-lts -y
    return $true
  }
  Write-Host "Winget/Chocolatey não encontrados. Baixe Node LTS manualmente: https://nodejs.org" -ForegroundColor Yellow
  return $false
}

# Instala Node se possível
$installed = Install-Node

Write-Host "Aguardando atualização de PATH (pode ser necessário reiniciar o terminal)..." -ForegroundColor Cyan
Start-Sleep -Seconds 3

# Vai para a pasta do projeto
if (-Not (Test-Path $projectPath)) {
  Write-Error "Projeto não encontrado em $projectPath"
  exit 1
}
Set-Location $projectPath

# Ajuste temporário do PATH (pode não funcionar sem reiniciar)
$env:PATH = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

# Verifica node/npm
if (-Not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node não disponível no PATH. Reinicie o terminal e rode manualmente:" -ForegroundColor Yellow
  Write-Host "  cd `"$projectPath`""; Write-Host "  npm install"
  exit 0
}

node -v
npm -v

# Roda npm install
Write-Host "Executando npm install..." -ForegroundColor Green
npm install --loglevel verbose

Write-Host "Instalação concluída (verifique erros acima). Para iniciar o bot:" -ForegroundColor Cyan
Write-Host "  cd `"$projectPath`""; Write-Host "  npm start"