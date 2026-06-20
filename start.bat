@echo off
setlocal
title BunkrScr

echo.
echo  =========================================
echo       BunkrScr - Startup
echo  =========================================
echo.

:: Use explicit venv path — avoids PATH issues with Hermes/system Python
set VENV_PYTHON=%~dp0.venv\Scripts\python.exe

:: Check if .venv exists
if not exist "%VENV_PYTHON%" (
    echo [1/3] Creating virtual environment...
    python -m venv "%~dp0.venv"
)

:: Install requirements
echo [2/2] Checking dependencies...
"%VENV_PYTHON%" -m pip install -r "%~dp0requirements.txt" --quiet

:: Start CLI
cls
"%VENV_PYTHON%" -m src.main_cli

pause
