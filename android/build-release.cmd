@echo off
rem Build the two signed release APKs and copy them where the server serves them:
rem   public/download/text-tunnel-phone-view.apk  (view only - no accessibility service, the default download)
rem   public/download/text-tunnel-phone.apk       (with control - accessibility service)
rem Needs Android Studio's JDK + SDK and the release keystore outside the repo (see android/README.md).
setlocal
if "%JAVA_HOME%"=="" set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.10.7-hotspot
if "%ANDROID_HOME%"=="" set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
cd /d "%~dp0"
call "%~dp0gradlew.bat" assembleViewRelease assembleControlRelease --no-daemon -q
if errorlevel 1 (echo BUILD FAILED & exit /b 1)
if not exist "..\public\download" mkdir "..\public\download"
copy /y "app\build\outputs\apk\view\release\app-view-release.apk" "..\public\download\text-tunnel-phone-view.apk" >nul
if errorlevel 1 (echo COPY FAILED - is the release APK signed? check the keystore properties & exit /b 1)
copy /y "app\build\outputs\apk\control\release\app-control-release.apk" "..\public\download\text-tunnel-phone.apk" >nul
if errorlevel 1 (echo COPY FAILED - is the release APK signed? check the keystore properties & exit /b 1)
echo BUILD OK: public\download\text-tunnel-phone-view.apk, public\download\text-tunnel-phone.apk
exit /b 0
