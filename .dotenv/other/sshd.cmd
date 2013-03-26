SET PATH=%PATH%;C:\cygwin\bin

C:
chdir C:\cygwin

start "" "C:\cygwin\startup\hstart.exe" /noconsole /elevate "C:\cygwin\usr\sbin\sshd.exe -D"