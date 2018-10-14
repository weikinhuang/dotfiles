@echo off

REM @see https://gist.github.com/jmickela/7c383c78af66a37a2446fe7eb733b157

setlocal enabledelayedexpansion
set command=%*

if exist "C:\Users\%USERNAME%\AppData\Local\Temp\git-commit-msg-.txt" (
for /f "delims=" %%i in ('type C:\Users\%USERNAME%\AppData\Local\Temp\git-commit-msg-.txt') do set commitmsg=!content! %%i
)

set find=-F C:\Users\%USERNAME%\AppData\Local\Temp\git-commit-msg-.txt
set replace=-m "%commitmsg%"

call set command=%%command:!find!=!replace!%%
If %PROCESSOR_ARCHITECTURE% == x86 (
    C:\Windows\Sysnative\wsl.exe bash -c 'git %command%'
) Else (
    C:\Windows\System32\wsl.exe bash -c 'git %command%'
)
