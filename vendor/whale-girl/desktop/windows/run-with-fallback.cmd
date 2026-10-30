@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
rem ————————————————————————————————————————————————————————————
rem 启动不了就双击我这个 · Launch with fallbacks
rem
rem 为什么需要：Issue #6 里有用户遇到「双击 exe 后无声无息退出（退出码 0，
rem 无窗口、无日志）」。这类通常是 Chromium 初始化（GPU / 沙箱）在特定
rem 机器或系统预览版上失败。这个脚本会逐个降级重试，并把每次结果写进日志，
rem 最后告诉你哪一种能跑起来 —— 你把这个结果发到 issue 就能帮我们定位。
rem ————————————————————————————————————————————————————————————
set EXE=%~dp0DS-WhaleGirl-Pet.exe
if not exist "%EXE%" (
  echo [X] 没找到 DS-WhaleGirl-Pet.exe，请确认这个脚本和 exe 在同一个文件夹里。
  pause & exit /b 2
)
set LOGDIR=%APPDATA%\ds-whale-girl-pet
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set LOG=%LOGDIR%\launcher.log

echo [i] 日志会写到: %LOG%
echo.

call :try "常规启动" ""
if !RC!==0 goto :ok
call :try "禁用 GPU（--disable-gpu）" "--disable-gpu"
if !RC!==0 goto :ok
call :try "禁用 GPU + 沙箱（--disable-gpu --no-sandbox）" "--disable-gpu --no-sandbox"
if !RC!==0 goto :ok
call :try "软件渲染（--disable-gpu --disable-software-rasterizer --no-sandbox）" "--disable-gpu --disable-software-rasterizer --no-sandbox"
if !RC!==0 goto :ok

echo [X] 四种方式都没能启动。请把日志发上来：
echo     %LOG%
echo     以及系统版本（winver）和显卡型号。
pause & exit /b 1

:ok
echo.
echo [OK] 上一种方式可以正常启动 —— 请把这个结果（第几行成功）发到 issue，谢谢！
pause & exit /b 0

:try
echo [>] 尝试 %~1 …
echo [%DATE% %TIME%] try: %~1 %~2 >> "%LOG%"
start "" /wait "%EXE%" %~2
set RC=!errorlevel!
echo [%DATE% %TIME%] exit=!RC! args=%~2 >> "%LOG%"
if !RC!==0 (
  echo     ^-^> 成功（可能已弹出窗口；若窗口没出现但也返回 0，说明是"静默退出"，也请告诉我们）
) else (
  echo     ^-^> 退出码 !RC!
)
exit /b !RC!
