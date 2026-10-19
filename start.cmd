@echo off
rem Rooms have their own passwords now. MAX_MB = largest file, MEM_MB = total file memory.
set PORT=8787
set MAX_MB=300
set MEM_MB=1024
"C:\Program Files\nodejs\node.exe" "%~dp0server.js"
pause
