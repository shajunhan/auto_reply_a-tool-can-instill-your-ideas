@echo off
title Thought Library
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install from https://nodejs.org
  pause
  exit /b
)

set PORT=8688
for /f "delims=" %%i in ('node -e "try{console.log(require('./config.json').port||8688)}catch(e){console.log(8688)}" 2^>nul') do set PORT=%%i

rem If the server is already running, just open the browser.
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%"
  exit /b
)

rem Start the server in a minimized window.
start "Thought Library Server" /min cmd /c "node server.js"

rem Poll until the port is listening (up to 20 seconds), then open the browser.
set /a TRIES=0
:WAITLOOP
set /a TRIES+=1
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto UP
if %TRIES% GEQ 20 goto FAIL
>nul ping -n 2 127.0.0.1
goto WAITLOOP

:UP
start "" "http://127.0.0.1:%PORT%"
exit /b

:FAIL
echo [ERROR] Server failed to start within 20 seconds. Port %PORT% may be occupied or Node.js is broken.
pause
exit /b 1
