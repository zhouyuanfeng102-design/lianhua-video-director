@echo off
setlocal
chcp 65001 >nul
set "ROOT_DIR=%~dp0"
set "APP_DIR=%ROOT_DIR%交付\"
set "APP_EXE=%ROOT_DIR%交付\莲华视频导演台-1.7.2-便携版.exe"
if not exist "%APP_EXE%" (
  echo Lianhua portable exe not found.
  pause
  exit /b 1
)
set "TEMP=%APP_DIR%runtime-temp"
set "TMP=%TEMP%"
set "TMPDIR=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
start "" "%APP_EXE%"
endlocal
