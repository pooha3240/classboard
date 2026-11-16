@echo off
rem classboard installer for Windows (no GitHub account needed)
rem Opens the setup window (tools\install-windows-gui.ps1).
rem If the window cannot open, the text helper (tools\install-windows.ps1) opens instead.
powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\install-windows-gui.ps1"
if errorlevel 1 start "classboard" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-windows.ps1"
