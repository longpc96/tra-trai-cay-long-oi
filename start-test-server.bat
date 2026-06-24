@echo off
cd /d "%~dp0"
echo Dang mo web test tai http://localhost:3000
echo.
echo Neu Windows hoi quyen truy cap mang, hay bam Allow.
echo Dung dong cua so nay khi dang test web.
echo Mat khau quan tri mac dinh: 1234
echo.
start "" "http://localhost:3000"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0test_tcp_server.ps1"
pause
