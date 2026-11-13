@echo off
chcp 65001 >nul
title CS2 Tasks
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist node_modules\express goto install
goto run
:install
echo Устанавливаю зависимости (один раз)...
call npm install --omit=dev
if errorlevel 1 goto fail
:run
node src\index.js %*
echo.
echo Программа остановлена.
pause
exit /b 0
:nonode
echo Node.js не найден. Установите Node.js 20 или новее: https://nodejs.org
pause
exit /b 1
:fail
echo Не удалось установить зависимости. Проверьте интернет и запустите снова.
pause
exit /b 1
