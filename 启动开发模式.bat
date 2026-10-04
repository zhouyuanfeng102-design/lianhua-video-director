@echo off
setlocal
cd /d "%~dp0"
set "LIANHUA_DATA_DIR=%~dp0data"
set "TEMP=%~dp0runtime-temp"
set "TMP=%TEMP%"
set "TMPDIR=%TEMP%"
set "npm_config_cache=%~dp0.npm-cache"
set "ELECTRON_CACHE=%~dp0.electron-cache"
set "ELECTRON_BUILDER_CACHE=%~dp0.builder-cache"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%LIANHUA_DATA_DIR%" mkdir "%LIANHUA_DATA_DIR%"
call npm run desktop:dev
if errorlevel 1 pause
