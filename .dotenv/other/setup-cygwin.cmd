@ECHO OFF
REM -- Automates cygwin installation

SETLOCAL

REM -- Change to the directory of the executing batch file
CD %~dp0

REM -- Configure our paths
SET SITE=http://cygwin.mirrors.pair.com/
SET ROOTDIR=C:\cygwin
SET LOCALDIR=%ROOTDIR%\setup
SET SETUP_PATH=C:\setup.exe
SET SSHD_PORT=13610

mkdir "%ROOTDIR%"
mkdir "%LOCALDIR%"

REM -- These are the packages we will install (in addition to the default packages)
SET PACKAGES=bash-completion,bc,bind,ca-certificates,curl,fdupes,git,git-completion
SET PACKAGES=%PACKAGES%,inetutils,ncurses,openssh,openssl,procps,rsync,screen,vim,wget,xxd

REM -- Do it!
ECHO *** INSTALLING DEFAULT PACKAGES
%SETUP_PATH% -q -d -D -L -X -s %SITE% -l "%LOCALDIR%" -R "%ROOTDIR%"
ECHO.
ECHO.
ECHO *** INSTALLING CUSTOM PACKAGES
%SETUP_PATH% -q -d -D -L -X -s %SITE% -l "%LOCALDIR%" -R "%ROOTDIR%" -P %PACKAGES%

REM -- Show what we did
ECHO.
ECHO.
ECHO cygwin installation updated
ECHO - %PACKAGES%
ECHO.

REM -- make cygdrive root / instead of /cygdrive
ECHO.
ECHO.
ECHO updating cygdrive fstab
%ROOTDIR%\bin\bash.exe --login -c "sed -i 's/# none \/cygdrive cygdrive /none \/ cygdrive /' /etc/fstab"
ECHO.
ECHO.

REM -- make the home directory
ECHO.
ECHO.
ECHO making the home directory be the windows home
REM -- WIN XP-
%ROOTDIR%\bin\bash.exe --login -c "if [[ -d \"/c/Documents and Settings/$USER\" ]]; then mv \"/home/$USER\" \"/home/$USER.bak\"; ln -s \"/c/Documents and Settings/$USER\" \"/home/$USER\"; fi;"
REM -- WIN Vista+
%ROOTDIR%\bin\bash.exe --login -c "if [[ -d \"/c/Users/$USER\" ]]; then mv \"/home/$USER\" \"/home/$USER.bak\"; ln -s \"/c/Users/$USER\" \"/home/$USER\"; fi;"
ECHO.
ECHO.

REM -- setup sshd for local user only
ECHO.
ECHO.
ECHO setup sshd for local user only
%ROOTDIR%\bin\bash.exe --login -c "ssh-host-config --no --port %SSHD_PORT%"
%ROOTDIR%\bin\bash.exe --login -c "sed -i 's/^#ListenAddress 0.0.0.0$/ListenAddress 127.0.0.1/' /etc/sshd_config"
%ROOTDIR%\bin\bash.exe --login -c "sed -i 's/^#ListenAddress ::$/ListenAddress ::1/' /etc/sshd_config"
%ROOTDIR%\bin\bash.exe --login -c "sed -i 's/^#PasswordAuthentication yes$/PasswordAuthentication no/' /etc/sshd_config"
%ROOTDIR%\bin\bash.exe --login -c "if [[ ! -f ~/.ssh/id_rsa ]]; then ssh-keygen -q -t rsa -N '' -f ~/.ssh/id_rsa && cat ~/.ssh/id_rsa.pub >> ~/.ssh/authorized_keys && chmod 0600 ~/.ssh/authorized_keys; fi;"
%ROOTDIR%\bin\bash.exe --login -c "echo '' > /etc/motd"
ECHO.
ECHO.

ENDLOCAL

PAUSE
EXIT /B 0