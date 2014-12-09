# create all defined cygwin wrappers
function __createcygwinwrappers() {
	local OFFICE_VER X86_PGM_PATH ZEND_VERSION

	# variables
	OFFICE_VER=${__CYG_OFFICE_VERSION-15}
	unset __CYG_OFFICE_VERSION
	X86_PGM_PATH="Program Files"
	if [[ -d "/c/Program Files (x86)/" ]]; then
		X86_PGM_PATH="Program Files (x86)"
	fi

	# gui based applications
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Acrobat 10.0/Acrobat/Acrobat.exe" acrobat
	__cygexewrap "c:/Program Files/Adobe/Adobe After Effects CS5.5/Support Files/AfterFX.exe" afterfx
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Adobe Audition CS5.5/Adobe Audition.exe" audition
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Adobe Dreamweaver CS5.5/Dreamweaver.exe" dreamweaver
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Adobe Encore CS5.1/Adobe Encore.exe" encore
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Adobe Fireworks CS5.1/Fireworks.exe" fireworks
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Adobe Flash CS5.5/Flash.exe" flash
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Adobe Illustrator CS5.1/Support Files/Contents/Windows/Illustrator.exe" illustrator
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Adobe InDesign CS5.5/InDesign.exe" indesign
	__cygexewrap "c:/${X86_PGM_PATH}/Adobe/Adobe OnLocation CS5.1/Adobe OnLocation.exe" onlocation
	__cygexewrap "c:/Program Files/Adobe/Adobe Premiere Pro CS5.5/Adobe Premiere Pro.exe" premiere
	__cygexewrap "c:/Program Files/Adobe/Adobe Photoshop CS5.1 (64 Bit)/Photoshop.exe" photoshop
	
	__cygexewrap "c:/Program Files/Araxis/Araxis Merge/Compare.exe" compare
	__cygexewrap "c:/Program Files/Araxis/Araxis Merge/AraxisSVNDiff.exe" comparesvndiff
	__cygexewrap "c:/Program Files/Araxis/Araxis Merge/AraxisSVNDiff3.exe" comparesvndiff3
	__cygexewrap "c:/Program Files/Araxis/Araxis Merge/AraxisSVNMerge.exe" comparesvnmerge
	__cygexewrap "c:/Program Files/Araxis/Araxis Merge/Merge.exe" merge
	
	__cygexewrap "c:/${X86_PGM_PATH}/Google/Chrome/Application/chrome.exe" chrome
	__cygexewrap "c:/Users/$(whoami)/AppData/Local/Google/Chrome SxS/Application/chrome.exe" chromecanary
	__cygexewrap "c:/Windows/system32/explorer.exe" explorer
	__cygexewrap "c:/${X86_PGM_PATH}/Mozilla Firefox/firefox.exe" firefox
	__cygexewrap "c:/${X86_PGM_PATH}/Internet Explorer/iexplore.exe" ie
	__cygexewrap "c:/Program Files/Internet Explorer/iexplore.exe" ie64
	
	__cygexewrap "c:/Program Files/Microsoft Office/Office${OFFICE_VER}/EXCEL.EXE" excel
	__cygexewrap "c:/Program Files/Microsoft Office/Office${OFFICE_VER}/POWERPNT.EXE" powerpoint
	__cygexewrap "c:/Program Files/Microsoft Office/Office${OFFICE_VER}/WINWORD.EXE" word
	
	__cygexewrap "c:/Program Files/Charles/Charles.exe" charles
	__cygexewrap "c:/${X86_PGM_PATH}/Notepad++/notepad++.exe" nppedit
	__cygexewrap "c:/${X86_PGM_PATH}/Pidgin/pidgin.exe" pidgin
	__cygexewrap "c:/Program Files/WinRAR/Rar.exe" rar
	__cygexewrap "c:/Program Files/VanDyke Software/SecureCRT/SecureCRT.exe" securecrt
	__cygexewrap "c:/${X86_PGM_PATH}/Symantec/Symantec Endpoint Protection/12.1.1000.157.105/Bin/SymCorpUI.exe" symantec
	__cygexewrap "c:/${X86_PGM_PATH}/UltraISO/UltraISO.exe" ultraiso
	__cygexewrap "c:/Program Files/WinRAR/UnRAR.exe" unrar
	__cygexewrap "c:/Program Files/WinRAR/WinRAR.exe" winrar
	__cygexewrap "c:/${X86_PGM_PATH}/Symantec/Symantec Endpoint Protection/DoScan.exe" avscan
	
	__cygexewrap "c:/Windows/system32/notepad.exe" np
	__cygexewrap "c:/${X86_PGM_PATH}/Windows Media Player/wmplayer.exe" wmplayer "/prefetch:1"
	__cygexewrap "c:/${X86_PGM_PATH}/Windows NT/Accessories/wordpad.exe" wordpad

	# vmware applications
	if [[ -d "/c/${X86_PGM_PATH}/VMware/VMware Workstation/" ]]; then
		__cygexewrap "c:/${X86_PGM_PATH}/VMware/VMware Workstation/vmrun.exe" vmrun
		__cygexewrap "c:/${X86_PGM_PATH}/VMware/VMware Workstation/vmware.exe" vmware
	else
		__cygexewrap "c:/${X86_PGM_PATH}/VMware/VMware Player/vmrun.exe" vmrun
		__cygexewrap "c:/${X86_PGM_PATH}/VMware/VMware Player/vmplayer.exe" vmware
	fi

	# cli based applications
	# __cygcliwrap "c:/Program Files/nodejs/node.exe" node # we don't do this because we want # ! /usr/bin/env node to work
	__cygcliwrap "c:/${X86_PGM_PATH}/phantomjs/phantomjs.exe" phantomjs
	__cygcliwrap "c:/Windows/System32/cmd.exe" wcmd
	__cygcliwrap "c:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" wpowershell

	# special case for getting the latest zend studio
	if [[ -d "/c/${X86_PGM_PATH}/Zend/" ]]; then
		ZEND_VERSION=$(find "$(cygpath -u "c:/${X86_PGM_PATH}/Zend/")" -maxdepth 2 -name "ZendStudio.exe" -type f | cut -d'/' -f5 | cut -d' ' -f3 | sort -n | tail -n1)
		__cygexewrap "c:/${X86_PGM_PATH}/Zend/Zend Studio ${VERSION}/ZendStudio.exe"
	fi
}
__createcygwinwrappers >> /dev/null
unset __createcygwinwrappers
