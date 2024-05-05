@echo off
::
:: Basic shim to call WSL executable with same name as this BAT file
::
:: Copyright (c) 2020 Dale Phurrough with MIT License:
:: Permission is hereby granted, free of charge, to any person obtaining a copy
:: of this software and associated documentation files (the "Software"), to deal
:: in the Software without restriction, including without limitation the rights
:: to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
:: copies of the Software, and to permit persons to whom the Software is
:: furnished to do so, subject to the following conditions:
:: The above copyright notice and this permission notice shall be included in all
:: copies or substantial portions of the Software.
:: THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
:: IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
:: FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
:: AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
:: LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
:: OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
:: SOFTWARE.
::
:: https://gist.github.com/diablodale/54756043c395d712053cf0d50a86086a
::
:: Indiscriminate mutation of parameters. You can add/adjust.
:: * change backslash to forward slashes
:: * change case-insensitive c: to /mnt/c
::
:: Install
:: 1.  Windows 10 v1903 or newer with a working WSL installation.
:: 2.  Make a copy of this file and name it the same as your WSL executable plus the extension ".BAT".
::     The extension ".BAT" must be capital letters. For example:
::     a) to run ssh in WSL, name this file "ssh.BAT"
::     b) to run ctags in WSL, name this file "ctags.BAT"
:: 3.  Your WSL .profile and .bashrc must not add any output. Otherwise, their output would be mixed
::     with the WSL executable's output and corrupt the data stream.
:: 4.  Test your install by copying this BAT file to "true.BAT"
:: 5.  At a CMD prompt, type:  true.BAT
:: 6.  You should see no output and no errors
:: 7.  At the same CMD prompt, type:  true.BAT > true.out
:: 8.  You should see no output and no errors
:: 9.  At the same CMD prompt, type:  dir true.out
:: 10. You should see a file named "true.out" with a file size of 0 bytes.
::     If you have any size greater than 0 bytes, then you must edit your WSL .profile and .bashrc
::     so that they add no output to stdout/stderr.
::
:: Hints
:: 1   Be mindful of your PATH
::     a) the location you save this BAT file may be (or not) in your PATH
::     b) the order of your PATH is important. For example, Windows 10 often has installed a Win32 executable
::        named "ssh.EXE" and it is usually in your PATH. If you created "ssh.BAT", then the order in which
::        your PATH is searched will determine which ssh is run.
::     c) If you specify the full path to your ssh.BAT file, you can avoid PATH search issues
:: 2.  To use this file for ssh in VSCode, I recommend your edit VSCode settings.json to declare
::     the full path to this file. Capitalize the drive letter and use double-backslashes to separate
::     the directory names. E.g.:
::         "remote.SSH.path": "C:\\path\\to\\your\\folder\\ssh.BAT",
:: 3.  Some components of VSCode only look in PATH for tools like ssh. These components ignore
::     the settings "remote.SSH.path". You may be forced to edit your PATH, uninstall the Win32 ssh.EXE, etc.
::     so that this "ssh.BAT" is used by VSCode.
::
SETLOCAL EnableExtensions
SETLOCAL DisableDelayedExpansion
set v_params=%*
set v_params=%v_params:\=/%
set v_params=%v_params:c:=/mnt/c%
REM set v_params=%v_params:"=\"%

If %PROCESSOR_ARCHITECTURE% == x86 (
  C:\Windows\Sysnative\wsl.exe bash -ic -- "%~n0 %v_params%"
) Else (
  C:\Windows\system32\wsl.exe bash -ic -- "%~n0 %v_params%"
)
