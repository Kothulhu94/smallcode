@echo off
title KoboldCPP
bin\koboldcpp.exe --model "models\google_gemma-4-E4B-it-Q4_K_M.gguf" --port 5001 --usevulkan --gpulayers 999 --contextsize 12288 --flashattention --useswa --jinja --jinja-tools
pause
