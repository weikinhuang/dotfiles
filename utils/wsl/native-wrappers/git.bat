@echo off

SETLOCAL ENABLEDELAYEDEXPANSION

set SCRIPT_PATH=%~dp0
set SCRIPT_PATH_ESCAPE=%SCRIPT_PATH:\=\\%

If %PROCESSOR_ARCHITECTURE% == x86 (
  for /f "delims=" %%i in ('C:\Windows\Sysnative\wsl.exe wslpath -ua "%SCRIPT_PATH_ESCAPE%"') do set "SCRIPT_PATH_WSL=%%i"
) Else (
  for /f "delims=" %%i in ('wsl.exe wslpath -ua "%SCRIPT_PATH_ESCAPE%"') do set "SCRIPT_PATH_WSL=%%i"
)

set PARAMS=%*
set ESCAPED_PARAMS=%PARAMS:\=\\%

If %PROCESSOR_ARCHITECTURE% == x86 (
  C:\Windows\Sysnative\wsl.exe %SCRIPT_PATH_WSL%/wslgit %ESCAPED_PARAMS%
) Else (
  C:\Windows\System32\wsl.exe %SCRIPT_PATH_WSL%/wslgit %ESCAPED_PARAMS%
)
