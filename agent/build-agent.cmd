@echo off
rem Build remote-agent.exe with the C# compiler that ships with Windows (no SDK needed, C# 5 only).
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (echo csc.exe not found: %CSC% & exit /b 1)
"%CSC%" /nologo /target:winexe /optimize+ /codepage:65001 /out:"%~dp0remote-agent.exe" ^
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll ^
  "%~dp0Program.cs"
exit /b %ERRORLEVEL%
