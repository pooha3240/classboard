@echo off
rem classboard installer for Windows (no GitHub account needed)
rem Runs tools\install-windows.ps1 with PowerShell.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-windows.ps1"
