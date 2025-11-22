@echo off
echo ===============================================
echo    SmartFrame Web Scraper Launcher
echo ===============================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed!
    echo.
    echo Please install Node.js from: https://nodejs.org/
    echo Download the LTS version, install it, and restart your computer.
    echo.
    pause
    exit /b 1
)

echo Node.js found: 
node --version
echo.

REM Check if dependencies are installed
REM We check for cross-env specifically as it's needed for the dev script
if not exist "node_modules\cross-env\" (
    echo Installing dependencies...
    echo This may take a few minutes...
    echo.
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo ERROR: Failed to install dependencies!
        echo Please check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo Dependencies installed successfully!
    echo.
)

REM Check for .env file, create a default one if it doesn't exist
if not exist ".env" (
    echo No .env file found - creating default configuration...
    echo.
    echo # Auto-generated configuration for local development > .env
    echo # Using SQLite database (no external database needed) >> .env
    echo NODE_ENV=development >> .env
    echo PORT=5000 >> .env
    echo SQLITE_DB_PATH=./data/local.db >> .env
    echo. >> .env
    echo # To use PostgreSQL instead, add: >> .env
    echo # DATABASE_URL=postgresql://username:password@localhost:5432/smartframe_db >> .env
    echo.
    echo Created .env file with SQLite database configuration
    echo Data will be stored in ./data/local.db
    echo.
)

echo Starting SmartFrame Web Scraper...
echo.
echo The application will open at: http://localhost:5000
echo.
echo Press Ctrl+C to stop the server when you're done.
echo ===============================================
echo.

REM Start the development server
call npm run dev
