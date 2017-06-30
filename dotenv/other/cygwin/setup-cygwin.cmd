@ECHO OFF
REM -- Automates cygwin installation

SETLOCAL

REM -- Change to the directory of the executing batch file
CD %~dp0

REM -- Configure our paths
SET ROOTDIR=C:\cygwin
SET SITE=http://mirrors.kernel.org/sourceware/cygwin/
SET SSHD_PORT=13610
SET SSH_TASK_TEMPLATE_URL=https://raw.githubusercontent.com/weikinhuang/dotfiles/master/dotenv/other/cygwin/win-schtasks-ssh.xml

REM -- Additional variables
SET ADD_ARGS=""
SET LOCALDIR="%ROOTDIR%\setup"
IF "%PROCESSOR_ARCHITECTURE%" == "x86" (
    SET SETUP_NAME=setup-x86.exe
) ELSE (
    SET SETUP_NAME=setup-x86_64.exe
)

REM -- STARTING SCRIPT
set DLOAD_SCRIPT=download.vbs

REM -- pure batch downloader: https://semitwist.com/articles/article/view/downloading-files-from-plain-batch-with-zero-dependencies
REM -- Windows has no built-in wget or curl, so generate a VBS script to do it:
REM -------------------------------------------------------------------------
ECHO Option Explicit                                                    >  %DLOAD_SCRIPT%
ECHO Dim args, http, fileSystem, adoStream, url, target, status         >> %DLOAD_SCRIPT%
ECHO.                                                                   >> %DLOAD_SCRIPT%
ECHO Set args = Wscript.Arguments                                       >> %DLOAD_SCRIPT%
ECHO Set http = CreateObject("WinHttp.WinHttpRequest.5.1")              >> %DLOAD_SCRIPT%
ECHO url = args(0)                                                      >> %DLOAD_SCRIPT%
ECHO target = args(1)                                                   >> %DLOAD_SCRIPT%
ECHO WScript.Echo "Getting '" ^& target ^& "' from '" ^& url ^& "'..."  >> %DLOAD_SCRIPT%
ECHO.                                                                   >> %DLOAD_SCRIPT%
ECHO http.Open "GET", url, False                                        >> %DLOAD_SCRIPT%
ECHO http.Send                                                          >> %DLOAD_SCRIPT%
ECHO status = http.Status                                               >> %DLOAD_SCRIPT%
ECHO.                                                                   >> %DLOAD_SCRIPT%
ECHO If status ^<^> 200 Then                                            >> %DLOAD_SCRIPT%
ECHO     WScript.Echo "FAILED to download: HTTP Status " ^& status      >> %DLOAD_SCRIPT%
ECHO     WScript.Quit 1                                                 >> %DLOAD_SCRIPT%
ECHO End If                                                             >> %DLOAD_SCRIPT%
ECHO.                                                                   >> %DLOAD_SCRIPT%
ECHO Set adoStream = CreateObject("ADODB.Stream")                       >> %DLOAD_SCRIPT%
ECHO adoStream.Open                                                     >> %DLOAD_SCRIPT%
ECHO adoStream.Type = 1                                                 >> %DLOAD_SCRIPT%
ECHO adoStream.Write http.ResponseBody                                  >> %DLOAD_SCRIPT%
ECHO adoStream.Position = 0                                             >> %DLOAD_SCRIPT%
ECHO.                                                                   >> %DLOAD_SCRIPT%
ECHO Set fileSystem = CreateObject("Scripting.FileSystemObject")        >> %DLOAD_SCRIPT%
ECHO If fileSystem.FileExists(target) Then fileSystem.DeleteFile target >> %DLOAD_SCRIPT%
ECHO adoStream.SaveToFile target                                        >> %DLOAD_SCRIPT%
ECHO adoStream.Close                                                    >> %DLOAD_SCRIPT%
ECHO.                                                                   >> %DLOAD_SCRIPT%
REM -------------------------------------------------------------------------

mkdir "%ROOTDIR%"
mkdir "%LOCALDIR%"

IF NOT EXIST "%ROOTDIR%\%SETUP_NAME%" cscript //Nologo "%DLOAD_SCRIPT%" http://cygwin.com/%SETUP_NAME% "%ROOTDIR%\%SETUP_NAME%"

REM -- cleanup temp files
del "%DLOAD_SCRIPT%"

REM -- These are the packages we will install (in addition to the default packages)
SET PACKAGES=bash-completion,bc,bind,ca-certificates,curl,cygutils-extra,git,git-completion,git-svn,gnupg
SET PACKAGES=%PACKAGES%,inetutils,jq,nc,nc6,ncurses,openssh,openssl,procps,rsync,screen,unzip,vim,wget,xxd
REM -- Extra packages
SET PACKAGES=%PACKAGES%,GraphicsMagick,ImageMagick,aspell,aspell-en,bzip2,fdupes,heimdal,mkisofs,p7zip

REM -- Do it!
ECHO *** INSTALLING DEFAULT PACKAGES
"%ROOTDIR%\%SETUP_NAME%" -q -d -D -L -X -s "%SITE%" -l "%LOCALDIR%" -R "%ROOTDIR%" %ADD_ARGS%
ECHO.
ECHO.
ECHO *** INSTALLING CUSTOM PACKAGES
"%ROOTDIR%\%SETUP_NAME%" -q -d -D -L -X -s "%SITE%" -l "%LOCALDIR%" -R "%ROOTDIR%" -P "%PACKAGES%" %ADD_ARGS%

REM -- Show what we did
ECHO.
ECHO.
ECHO cygwin installation updated
ECHO - "%PACKAGES%"
ECHO.

REM -- make cygdrive root / instead of /cygdrive
ECHO.
ECHO.
ECHO updating cygdrive fstab
"%ROOTDIR%\bin\bash.exe" --login -c "sed -i 's/# none \/cygdrive cygdrive /none \/ cygdrive /' /etc/fstab"
"%ROOTDIR%\bin\bash.exe" --login -c "sed -i 's/none \/cygdrive cygdrive /none \/ cygdrive /' /etc/fstab"
ECHO.
ECHO.

REM -- make the home directory
ECHO.
ECHO.
ECHO making the home directory be the windows home
REM -- WIN XP-
"%ROOTDIR%\bin\bash.exe" --login -c "if [[ -d \"/c/Documents and Settings/$USER\" ]]; then mv \"/home/$USER\" \"/home/$USER.bak\"; ln -s \"/c/Documents and Settings/$USER\" \"/home/$USER\"; fi;"
REM -- WIN Vista+
"%ROOTDIR%\bin\bash.exe" --login -c "if [[ -d \"/c/Users/$USER\" ]]; then mv \"/home/$USER\" \"/home/$USER.bak\"; ln -s \"/c/Users/$USER\" \"/home/$USER\"; fi;"
ECHO.
ECHO.

REM -- setup sshd for local user only
ECHO.
ECHO.
ECHO setup sshd for local user only
"%ROOTDIR%\bin\bash.exe" --login -c "ssh-host-config --no --port %SSHD_PORT%"
"%ROOTDIR%\bin\bash.exe" --login -c "sed -i 's/^#ListenAddress 0.0.0.0$/ListenAddress 127.0.0.1/' /etc/sshd_config"
"%ROOTDIR%\bin\bash.exe" --login -c "sed -i 's/^#ListenAddress ::$/ListenAddress ::1/' /etc/sshd_config"
"%ROOTDIR%\bin\bash.exe" --login -c "sed -i 's/^#PasswordAuthentication yes$/PasswordAuthentication no/' /etc/sshd_config"
"%ROOTDIR%\bin\bash.exe" --login -c "sed -i 's/^UsePrivilegeSeparation sandbox/#UsePrivilegeSeparation sandbox/' /etc/sshd_config"
"%ROOTDIR%\bin\bash.exe" --login -c "if [[ ! -f ~/.ssh/id_rsa ]]; then ssh-keygen -q -t rsa -N '' -f ~/.ssh/id_rsa && cat ~/.ssh/id_rsa.pub >> ~/.ssh/authorized_keys && chmod 0600 ~/.ssh/authorized_keys; fi;"
"%ROOTDIR%\bin\bash.exe" --login -c "echo > /etc/motd"
"%ROOTDIR%\bin\bash.exe" --login -c "if [[ ! -f /etc/passwd ]]; then touch /etc/passwd; fi;"
"%ROOTDIR%\bin\bash.exe" --login -c "if [[ ! -f /etc/group ]]; then touch /etc/group; fi;"
"%ROOTDIR%\bin\bash.exe" --login -c "if ! grep -q sshd /etc/passwd; then echo 'sshd:x:74:74:Privilege-separated SSH:/var/empty/sshd:/sbin/nologin' >> /etc/passwd; echo 'sshd:x:74:' >> /etc/group; fi;"

REM -- Sadly in the newest Windows 10: http://www.thewindowsclub.com/create-elevated-shortcut-run-programs-bypass-uac instead
"%ROOTDIR%\bin\bash.exe" --login -c "mkdir -p /startup"
"%ROOTDIR%\bin\bash.exe" --login -c "wget -O /startup/ssh-task.xml %SSH_TASK_TEMPLATE_URL%"
"%ROOTDIR%\bin\bash.exe" --login -c "sed -i 's/##HOSTNAME##/'$(hostname)'/' /startup/ssh-task.xml"
"%ROOTDIR%\bin\bash.exe" --login -c "sed -i 's/##USER##/'$(whoami)'/' /startup/ssh-task.xml"
schtasks /delete /f /tn cygwinsshd
schtasks /create /xml "%ROOTDIR%\startup\ssh-task.xml" /tn cygwinsshd

IF NOT EXIST "%ROOTDIR%\cygsetup.cmd" (
    echo "%ROOTDIR%\%SETUP_NAME%" -s "%SITE%" -l "%LOCALDIR%" -R "%ROOTDIR%" "%ADD_ARGS%" > "%ROOTDIR%\cygsetup.cmd"
)

ECHO.
ECHO.

ENDLOCAL

PAUSE
EXIT /B 0
