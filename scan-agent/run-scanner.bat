@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "CONFIG=%~1"
if "%CONFIG%"=="" set "CONFIG=config.scanner1.json"
if not exist "%CONFIG%" (
  echo ERROR: missing %CONFIG%
  exit /b 1
)
if not exist "daemon" mkdir daemon

:: Per-scanner log files so 1/2/3 don't overwrite each other
set "TAG=scanner1"
echo.%CONFIG% | findstr /I "scanner2" >nul && set "TAG=scanner2"
echo.%CONFIG% | findstr /I "scanner3" >nul && set "TAG=scanner3"

set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0agent.js" "%CONFIG%" >> "%~dp0daemon\%TAG%.out.log" 2>> "%~dp0daemon\%TAG%.err.log"
