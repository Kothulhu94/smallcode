@echo off
title Local Agent Harness Launcher

:: Force directory to be the repository root
cd /d "%~dp0"

echo [1/4] Launching KoboldCPP local model server in a new window...
start "KoboldCPP Server" run_kobold.bat

echo.
echo [2/4] Launching Observability Dashboard Server in a new window...
:: Starts the dashboard server with the portable node binary and titles the window
start "LAH Dashboard Server" cmd /k "title LAH Dashboard Server && %~d0\PortableNode\node.exe src\governor\dashboard_server.js 3000"

echo.
echo [3/4] Opening Observability Dashboard...
timeout /t 3 /nobreak > nul

:: Attempt to open in app mode using Microsoft Edge
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" >nul 2>&1 && (start "" msedge --app=http://localhost:3000 & goto opened)
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" >nul 2>&1 && (start "" msedge --app=http://localhost:3000 & goto opened)

:: Attempt to open in app mode using Google Chrome
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>&1 && (start "" chrome --app=http://localhost:3000 & goto opened)
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>&1 && (start "" chrome --app=http://localhost:3000 & goto opened)

:: Fallback to the system default browser
start "" http://localhost:3000

:opened
echo Dashboard opened successfully!

echo.
echo [4/4] Launching SmallCode Agent TUI...
echo (Note: KoboldCPP takes 30-60s to load the model tensors on CPU).
echo.

:: Launch the SmallCode TUI in the foreground of the current shell window
call run_smallcode_source.bat %*
