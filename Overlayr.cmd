@echo off
rem Overlayr launcher - double-click friendly.
rem ELECTRON_RUN_AS_NODE is cleared because some shells export it, which would
rem make Electron behave like a plain Node.js process.
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
