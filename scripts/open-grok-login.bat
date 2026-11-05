@echo off
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "PROFILE=%USERPROFILE%\.tokentracker\tracker\edge-profile"
if not exist "%USERPROFILE%\.tokentracker\tracker" mkdir "%USERPROFILE%\.tokentracker\tracker"
start "" "%EDGE%" --user-data-dir="%PROFILE%" "https://grok.com/dashboard/usage"
