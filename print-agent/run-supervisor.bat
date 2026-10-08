@echo off
:: Always-on local control server for UI start/stop buttons
title ElegancePrintSupervisor
cd /d "%~dp0"
if not exist "daemon" mkdir daemon

set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" "%~dp0supervisor.js" >> "%~dp0daemon\supervisor.out.log" 2>> "%~dp0daemon\supervisor.err.log"

