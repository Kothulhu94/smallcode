@echo off
title Local Model Harness Manager

echo [1/2] Launching KoboldCPP local model server in a new window...
start "KoboldCPP Server" run_kobold.bat

echo.
echo [2/2] Launching SmallCode agent...
echo (Note: KoboldCPP takes 30-60s to load the model tensors on CPU).
echo.

:: Launch SmallCode in interactive mode
call run_smallcode_source.bat
