@echo off
title KoboldCPP Local Server
bin\koboldcpp.exe --model models\google_gemma-4-E4B-it-Q4_K_M.gguf --usecpu --threads 6 --port 5001
pause
