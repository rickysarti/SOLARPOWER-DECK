$ErrorActionPreference = 'Continue'
$SourceBase = "C:\Users\Ricky\Desktop\CLAUDIO\CLAUDIO"
$DestBase   = "D:\CLAUDIO"
$botDir     = "$DestBase\solarpower-agent"

function Log($msg)     { Write-Host "$(Get-Date -Format 'HH:mm:ss')  $msg" }
function LogOk($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function LogWarn($msg) { Write-Host "  WARN: $msg" -ForegroundColor Yellow }
function LogErr($msg)  { Write-Host "  ERR: $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "=== MIGRACION BOTS: C: -> D:\CLAUDIO ===" -ForegroundColor Cyan
Write-Host ""

# Verificar D:
if (-not (Test-Path "D:\")) { LogErr "No existe D:. Abortando."; exit 1 }
$freeGB = [math]::Round((Get-PSDrive D).Free / 1GB, 1)
LogOk "D: disponible - $freeGB GB libres"

# Crear destino
if (-not (Test-Path $DestBase)) {
    New-Item -ItemType Directory -Path $DestBase -Force | Out-Null
    LogOk "Creado $DestBase"
}

# Detener procesos
Log "Deteniendo node y cloudflared..."
try {
    $netLines = netstat -aon 2>$null | Select-String ":3000 "
    foreach ($nl in $netLines) {
        $p = ($nl.Line.Trim() -split '\s+')[-1]
        if ($p -match '^\d+$' -and $p -ne '0') {
            taskkill /F /PID $p 2>$null | Out-Null
            LogOk "Killed PID $p"
        }
    }
} catch {}
try { taskkill /F /IM cloudflared.exe 2>$null | Out-Null; LogOk "cloudflared detenido" } catch {}
Start-Sleep -Seconds 2

# Copiar proyectos
$projects = Get-ChildItem -Path $SourceBase -Directory
Write-Host ""
Log "Copiando proyectos (sin node_modules ni logs)..."
foreach ($proj in $projects) {
    $src = $proj.FullName
    $dst = Join-Path $DestBase $proj.Name
    Log "  Copiando $($proj.Name)..."
    robocopy $src $dst /E /XD node_modules .git /XF "*.log" "*.db" "*.db-shm" "*.db-wal" /NP /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -lt 8) { LogOk "$($proj.Name) copiado" } else { LogWarn "$($proj.Name) exit=$LASTEXITCODE" }
}

# Copiar base de datos SQLite
Log "Copiando base de datos SQLite..."
$dataDir = "$SourceBase\solarpower-agent\data"
$dataDst = "$DestBase\solarpower-agent\data"
if (Test-Path $dataDir) {
    if (-not (Test-Path $dataDst)) { New-Item -ItemType Directory -Path $dataDst -Force | Out-Null }
    Copy-Item "$dataDir\*" -Destination $dataDst -Force
    LogOk "Base de datos copiada"
} else {
    LogWarn "No hay base de datos (se crea sola al arrancar)"
}

# npm install
Write-Host ""
Log "Instalando dependencias npm..."
foreach ($proj in $projects) {
    $pkgJson = Join-Path $DestBase "$($proj.Name)\package.json"
    if (Test-Path $pkgJson) {
        $projDst = Join-Path $DestBase $proj.Name
        Log "  npm install en $($proj.Name)..."
        Push-Location $projDst
        npm install --prefer-offline 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { LogOk "npm install OK - $($proj.Name)" } else { LogWarn "npm install warnings - $($proj.Name)" }
        Pop-Location
    }
}

# Arrancar bot desde D:
Write-Host ""
Log "Arrancando bot desde $botDir ..."
"" | Set-Content "$botDir\bot.log"
"" | Set-Content "$botDir\bot-err.log"
"" | Set-Content "$botDir\tunnel.log"
"" | Set-Content "$botDir\tunnel-err.log"

Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $botDir -WindowStyle Minimized -RedirectStandardOutput "$botDir\bot.log" -RedirectStandardError "$botDir\bot-err.log"
Log "Esperando 10s..."
Start-Sleep -Seconds 10

$port = netstat -aon 2>$null | Select-String ":3000 "
if ($port) { LogOk "Bot corriendo en puerto 3000" } else { LogWarn "Puerto 3000 no detectado - revisa bot-err.log" }

# Arrancar cloudflared
Log "Arrancando tunnel cloudflared..."
Start-Process -FilePath "cloudflared" -ArgumentList "tunnel","--url","http://localhost:3000" -WindowStyle Minimized -RedirectStandardOutput "$botDir\tunnel.log" -RedirectStandardError "$botDir\tunnel-err.log"
Log "Esperando 15s para la URL..."
Start-Sleep -Seconds 15

# Extraer URL
$url = ""
foreach ($f in @("$botDir\tunnel.log", "$botDir\tunnel-err.log")) {
    $content = Get-Content $f -ErrorAction SilentlyContinue
    foreach ($line in $content) {
        if ($line -match "https://[a-z0-9-]+\.trycloudflare\.com") {
            $url = $Matches[0]
            break
        }
    }
    if ($url) { break }
}

if ($url) { $url | Set-Content "$botDir\tunnel-url.txt" }

# Crear script de reinicio rapido en D:
$lines = @(
    '$botDir = "D:\CLAUDIO\solarpower-agent"',
    '"" | Set-Content "$botDir\bot.log"',
    '"" | Set-Content "$botDir\bot-err.log"',
    '"" | Set-Content "$botDir\tunnel.log"',
    '"" | Set-Content "$botDir\tunnel-err.log"',
    'Start-Process node -ArgumentList "index.js" -WorkingDirectory $botDir -WindowStyle Minimized -RedirectStandardOutput "$botDir\bot.log" -RedirectStandardError "$botDir\bot-err.log"',
    'Start-Sleep 10',
    'Start-Process cloudflared -ArgumentList "tunnel","--url","http://localhost:3000" -WindowStyle Minimized -RedirectStandardOutput "$botDir\tunnel.log" -RedirectStandardError "$botDir\tunnel-err.log"',
    'Start-Sleep 15',
    '$u = (Select-String -Path "$botDir\tunnel-err.log","$botDir\tunnel.log" -Pattern "trycloudflare\.com" -ErrorAction SilentlyContinue | Select-Object -First 1)',
    'if ($u) { $url2 = $u.Matches[0].Value; Write-Host "TUNNEL URL: $url2" -ForegroundColor Green; $url2 | Set-Content "$botDir\tunnel-url.txt" }'
)
$lines | Set-Content "D:\CLAUDIO\iniciar-bot.ps1" -Encoding UTF8

# Resultado
Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
if ($url) {
    Write-Host "  TODO LISTO" -ForegroundColor Green
    Write-Host ""
    Write-Host "  TUNNEL URL:" -ForegroundColor Yellow
    Write-Host "  $url" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Pega esa URL en SendPulse como webhook" -ForegroundColor White
} else {
    Write-Host "  Bot iniciado pero URL no detectada aun" -ForegroundColor Yellow
    Write-Host "  Revisa: $botDir\tunnel-err.log" -ForegroundColor White
}
Write-Host ""
Write-Host "  Bot en: D:\CLAUDIO\solarpower-agent" -ForegroundColor White
Write-Host "  Reinicio: D:\CLAUDIO\iniciar-bot.ps1" -ForegroundColor White
Write-Host "=========================================" -ForegroundColor Cyan
