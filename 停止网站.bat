@echo off
title Stop Thought Library
cd /d "%~dp0"

set PORT=8688
for /f "delims=" %%i in ('node -e "try{console.log(require('./config.json').port||8688)}catch(e){console.log(8688)}" 2^>nul') do set PORT=%%i

set KILLED=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  taskkill /f /pid %%a >nul 2>&1
  set KILLED=1
)
if "%KILLED%"=="1" (
  echo Server stopped. Port %PORT%
) else (
  echo No running server found.
)
timeout /t 2 /nobreak >nul 2>nul
exit /b
