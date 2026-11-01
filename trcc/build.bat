@echo off
REM Build trcc-token-dash.exe (windowed GUI) on Windows. Run from this folder.
REM   build.bat        -> dist\trcc-token-dash.exe      (GUI, no console)
REM   build.bat cli    -> also dist\trcc-token-dash-cli.exe (console build)
REM Requires: Python 3.10+ (python.org build, includes tkinter) on PATH.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: python not on PATH
  exit /b 1
)

python -c "import tkinter" >nul 2>&1
if errorlevel 1 (
  echo ERROR: this Python has no tkinter. Install Python from python.org with "tcl/tk" checked.
  exit /b 1
)

if not exist .venv (
  python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install -U pip
pip install -r requirements.txt
if errorlevel 1 exit /b 1

set "ADD_BIN="
if exist vendor\libusb-1.0.dll (
  set "ADD_BIN=--add-binary vendor\libusb-1.0.dll;."
  echo Bundling vendor\libusb-1.0.dll
) else (
  echo WARNING: vendor\libusb-1.0.dll missing - pyusb may fail to open the panel.
)

set "ADD_LHM="
if exist vendor\lhm\LibreHardwareMonitorLib.dll (
  set "ADD_LHM=--add-data vendor\lhm;lhm --collect-all pythonnet --collect-all clr_loader --hidden-import clr"
  echo Bundling vendor\lhm ^(LibreHardwareMonitorLib^)
) else (
  echo WARNING: vendor\lhm missing - CPU temp/power need LibreHardwareMonitor running.
)

set "COMMON=--noconfirm --onefile --add-data Inter.ttf;. --add-data NOTICE;. --add-data LICENSE;. !ADD_BIN! !ADD_LHM! --hidden-import usb.backend.libusb1 --hidden-import usb.backend.libusb0 --hidden-import PIL._tkinter_finder --hidden-import win32com.client --hidden-import pythoncom --hidden-import pywintypes --hidden-import pystray._win32"

pyinstaller --clean --windowed --name trcc-token-dash !COMMON! main.py
if errorlevel 1 goto :fail

if /I "%~1"=="cli" (
  pyinstaller --console --name trcc-token-dash-cli !COMMON! main.py
  if errorlevel 1 goto :fail
)

if exist dist\trcc-token-dash.exe (
  copy /Y vendor\libusb-1.0.dll dist\libusb-1.0.dll >nul 2>&1
  echo.
  echo OK: dist\trcc-token-dash.exe
  if /I "%~1"=="cli" echo OK: dist\trcc-token-dash-cli.exe
  echo Quit official TRCC first, then double-click the exe.
  exit /b 0
)

:fail
echo BUILD FAILED
exit /b 1
