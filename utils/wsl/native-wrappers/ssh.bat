@echo off

set v_params=%*
set v_params=%v_params:\=/%
set v_params=%v_params:c:=/mnt/c%
REM set v_params=%v_params:"=\"%

If %PROCESSOR_ARCHITECTURE% == x86 (
  C:\Windows\Sysnative\wsl.exe ssh %v_params%
) Else (
  C:\Windows\System32\wsl.exe ssh %v_params%
)
