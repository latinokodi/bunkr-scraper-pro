@echo off
title Bunkr Scraper PRO
echo [OK] 1: Starting Bunkr Scraper PRO...

cd /d "%~dp0"

echo [OK] 2: Activating Python venv...
call ".venv\Scripts\activate.bat"

echo [OK] 3: Checking dependencies...
python -m pip install -r requirements.txt --quiet

echo [OK] 4: Entering Electron folder...
cd electron

echo [OK] 5: Launching App...
call npx electron .

if errorlevel 1 (
    echo [ERROR] Electron failed to start.
    pause
)

cd ..
exit /b 0
