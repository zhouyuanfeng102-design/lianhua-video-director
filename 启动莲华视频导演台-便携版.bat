@echo off
setlocal
chcp 65001 >nul
set "APP_DIR=%~dp0"
set "TEMP=%APP_DIR%runtime-temp"
set "TMP=%TEMP%"
set "TMPDIR=%TEMP%"
set "APP_EXE=%APP_DIR%交付\莲华视频导演台-1.4.9-便携版.exe"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%APP_EXE%" (
  echo Lianhua portable 1.4.9 exe not found.
  pause
  exit /b 1
)
start "" "%APP_EXE%"
endlocal
