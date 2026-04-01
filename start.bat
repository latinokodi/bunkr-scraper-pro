@echo off
setlocal

:: ── Change to script's own directory
cd /d "%~dp0"

echo ============================================
echo   Bunkr Scraper - Launcher
echo ============================================
echo.

:: ────────────────────────────────────────────────────────────────────────────
:: STEP 1 — Python virtual environment
:: ────────────────────────────────────────────────────────────────────────────
if not exist ".venv\Scripts\python.exe" (
    echo [SETUP] Python virtual environment not found.
    python --version >nul 2>&1
    if errorlevel 1 (
        echo  ERROR: Python is not installed or not in PATH.
        pause & exit /b 1
    )
    echo [SETUP] Creating environment...
    python -m venv .venv
    if errorlevel 1 (
        echo  ERROR: Could not create virtual environment.
        pause & exit /b 1
    )

    echo [SETUP] Installing Python dependencies...
    call .venv\Scripts\activate.bat
    python -m pip install --upgrade pip --quiet
    pip install -r requirements.txt --quiet
    if errorlevel 1 (
        echo  ERROR: Failed to install Python dependencies.
        pause & exit /b 1
    )
) else (
    echo [OK] Python environment found.
    call .venv\Scripts\activate.bat
)

:: ────────────────────────────────────────────────────────────────────────────
:: STEP 2 — Node / Electron dependencies
:: ────────────────────────────────────────────────────────────────────────────
if not exist "electron\node_modules\electron" (
    echo [SETUP] Electron missing. Installing...
    cd electron
    call npm install
    if errorlevel 1 (
        echo  ERROR: npm install failed.
        cd ..
        pause & exit /b 1
    )
    cd ..
) else (
    echo [OK] Electron environment found.
)

:: ────────────────────────────────────────────────────────────────────────────
:: STEP 3 — Launch
:: ────────────────────────────────────────────────────────────────────────────
echo.
echo [LAUNCH] Starting Bunkr Scraper...
cd electron

:: Try running electron directly from node_modules for better reliability
if exist "node_modules\.bin\electron.cmd" (
    call node_modules\.bin\electron.cmd .
) else (
    call npx electron .
)

if errorlevel 1 (
    echo.
    echo  ERROR: Electron failed to start.
    echo.
    pause
)

cd ..
