@echo off
REM ---------------------------------------------------------------
REM Code Universe - dev launcher
REM Starts the dev server (app + SQLite API) in its own window, waits
REM for it to come up, then opens it in your default browser.
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
    echo [start-dev] node_modules not found - running npm install first...
    call npm install
)

echo [start-dev] Starting dev server...
start "Code Universe - dev server" cmd /k npm run dev

echo [start-dev] Waiting for server to come up...
timeout /t 4 /nobreak >nul

start "" http://localhost:5199

echo [start-dev] Opened http://localhost:5199 in your browser.
endlocal
