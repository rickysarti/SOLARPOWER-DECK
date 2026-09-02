@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM  run-morning-report.bat
REM  Reporte matutino SolarPower — ejecutar con Windows Task Scheduler
REM  Horario sugerido: 8:00 AM todos los días
REM ─────────────────────────────────────────────────────────────────────────

cd /d "C:\Users\Ricky\Desktop\CLAUDIO\solarpower-agent"
node morning-report.js >> logs\morning-report.log 2>&1
