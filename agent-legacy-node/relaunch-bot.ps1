# === RELAUNCH SOLARPOWER BOT + CLOUDFLARED ===
$WorkDir = "C:\Users\Ricky\Desktop\CLAUDIO\CLAUDIO\solarpower-agent"

Write-Host "=== Killing existing processes ===" -ForegroundColor Yellow

# Kill node on port 3000
$pids = netstat -aon | findstr ":3000" | ForEach-Object { ($_ -split '\s+')[5] } | Sort-Object -Unique
foreach ($p in $pids) {
    if ($p -match '^\d+$' -and $p -ne '0') {
        Write-Host "Killing PID $p (port 3000)"
        taskkill /F /PID $p 2>$null
    }
}

# Kill cloudflared
taskkill /F /IM cloudflared.exe 2>$null
Start-Sleep -Seconds 2

Write-Host "=== Starting bot (node index.js) ===" -ForegroundColor Yellow
$botOut = Join-Path $WorkDir "bot.log"
$botErr = Join-Path $WorkDir "bot-err.log"
"" | Set-Content $botOut
"" | Set-Content $botErr

Start-Process -FilePath "node" `
    -ArgumentList "index.js" `
    -WorkingDirectory $WorkDir `
    -WindowStyle Minimized `
    -RedirectStandardOutput $botOut `
    -RedirectStandardError $botErr

Write-Host "Waiting 8 seconds for bot to start..."
Start-Sleep -Seconds 8

# Check if port 3000 is listening
$port3000 = netstat -aon | findstr ":3000"
if ($port3000) {
    Write-Host "✅ Bot is running on port 3000" -ForegroundColor Green
} else {
    Write-Host "⚠️  Port 3000 not detected yet - check bot-err.log" -ForegroundColor Red
}

Write-Host "=== Starting cloudflared tunnel ===" -ForegroundColor Yellow
$tunnelOut = Join-Path $WorkDir "tunnel.log"
$tunnelErr = Join-Path $WorkDir "tunnel-err.log"
"" | Set-Content $tunnelOut
"" | Set-Content $tunnelErr

Start-Process -FilePath "cloudflared" `
    -ArgumentList "tunnel", "--url", "http://localhost:3000" `
    -WindowStyle Minimized `
    -RedirectStandardOutput $tunnelOut `
    -RedirectStandardError $tunnelErr

Write-Host "Waiting 12 seconds for tunnel URL..."
Start-Sleep -Seconds 12

# Extract tunnel URL
$url = ""
foreach ($file in @($tunnelOut, $tunnelErr)) {
    $content = Get-Content $file -ErrorAction SilentlyContinue
    foreach ($line in $content) {
        if ($line -match "https://[a-z0-9\-]+\.trycloudflare\.com") {
            $url = $matches[0]
            break
        }
    }
    if ($url) { break }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
if ($url) {
    Write-Host "✅ TUNNEL URL: $url" -ForegroundColor Green
    $url | Set-Content (Join-Path $WorkDir "tunnel-url.txt")
    Write-Host "   (also saved to tunnel-url.txt)" -ForegroundColor Gray
} else {
    Write-Host "⚠️  Could not find tunnel URL yet" -ForegroundColor Red
    Write-Host "   Check tunnel.log and tunnel-err.log manually" -ForegroundColor Gray
}
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press any key to close..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
