@echo off
rem Build the signed release APK and copy it where the server serves it (public/download/text-tunnel-phone.apk).
rem Needs Android Studio's JDK + SDK and the release keystore outside the repo (see android/README.md).
setlocal
if "%JAVA_HOME%"=="" set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.10.7-hotspot
if "%ANDROID_HOME%"=="" set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
cd /d "%~dp0"
call "%~dp0gradlew.bat" assembleRelease --no-daemon -q
if errorlevel 1 (echo BUILD FAILED & exit /b 1)
if not exist "..\public\download" mkdir "..\public\download"
copy /y "app\build\outputs\apk\release\app-release.apk" "..\public\download\text-tunnel-phone.apk" >nul
if errorlevel 1 (echo COPY FAILED - is the release APK signed? check the keystore properties & exit /b 1)
echo BUILD OK: public\download\text-tunnel-phone.apk
exit /b 0
