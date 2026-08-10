$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 9000
$url = "http://localhost:$port/"

function Test-HttpPort {
    param([int]$Port)
    try {
        $request = [System.Net.WebRequest]::Create("http://127.0.0.1:$Port/")
        $request.Timeout = 2000
        $response = $request.GetResponse()
        $response.Close()
        return $true
    } catch {
        return $false
    }
}

$pythonCommand = $null
foreach ($candidate in @('py', 'python', 'python3')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
        $pythonCommand = $cmd
        break
    }
}

if (-not $pythonCommand) {
    throw "Python não encontrado. Instale Python 3 e tente novamente."
}

$serverRunning = Test-HttpPort -Port $port
if (-not $serverRunning) {
    if ($pythonCommand.Name -eq 'py') {
        Start-Process -FilePath $pythonCommand.Source -ArgumentList @('-3', '-m', 'http.server', $port) -WorkingDirectory $repoRoot -WindowStyle Hidden
    } else {
        Start-Process -FilePath $pythonCommand.Source -ArgumentList @('-m', 'http.server', $port) -WorkingDirectory $repoRoot -WindowStyle Hidden
    }

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-HttpPort -Port $port) {
            break
        }
    }
}

Start-Process $url
Write-Host "Dashboard aberto em $url"
