@echo off
setlocal
cd /d "%~dp0"
copy /b app-debug.apk.part01+app-debug.apk.part02+app-debug.apk.part03+app-debug.apk.part04+app-debug.apk.part05+app-debug.apk.part06 app-debug.apk >nul
if errorlevel 1 exit /b 1
powershell -NoProfile -Command "if ((Get-FileHash -Algorithm SHA256 'app-debug.apk').Hash.ToLower() -ne '0ee21f59105a612c441e9eba31dc9ae02cc9cf237b55707a4df0e7b1416cd324') { throw 'SHA-256 mismatch' } else { Write-Host 'SHA-256 OK. Ready: app-debug.apk' }"
if errorlevel 1 exit /b 1
pause
