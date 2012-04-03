# This function defines a 'cd' replacement function capable of keeping, 
# displaying and accessing history of visited directories, up to 10 entries.
# To use it, uncomment it, source this file and try 'cd --'.
# acd_func 1.0.5, 10-nov-2004
# Petar Marinov, http:/geocities.com/h2428, this is public domain
cd_func () {
	local x2 the_new_dir adir index
	local -i cnt

	if [[ $1 ==	"--" ]]; then
		dirs -v
		return 0
	fi

	the_new_dir=$1
	[[ -z $1 ]] && the_new_dir=$HOME

	if [[ ${the_new_dir:0:1} == '-' ]]; then
		#
		# Extract dir N from dirs
		index=${the_new_dir:1}
		[[ -z $index ]] && index=1
		adir=$(dirs +$index)
		[[ -z $adir ]] && return 1
		the_new_dir=$adir
	fi

	#
	# '~' has to be substituted by ${HOME}
	[[ ${the_new_dir:0:1} == '~' ]] && the_new_dir="${HOME}${the_new_dir:1}"

	#
	# Now change to the new dir and add to the top of the stack
	pushd "${the_new_dir}" > /dev/null
	[[ $? -ne 0 ]] && return 1
	the_new_dir=$(pwd)

	#
	# Trim down everything beyond 11th entry
	popd -n +11 2>/dev/null 1>/dev/null

	#
	# Remove any other occurence of this dir, skipping the top of the stack
	for ((cnt=1; cnt <= 10; cnt++)); do
		x2=$(dirs +${cnt} 2>/dev/null)
		[[ $? -ne 0 ]] && return 0
		[[ ${x2:0:1} == '~' ]] && x2="${HOME}${x2:1}"
		if [[ "${x2}" == "${the_new_dir}" ]]; then
			popd -n +$cnt 2>/dev/null 1>/dev/null
			cnt=cnt-1
		fi
	done

	return 0
}
alias cd=cd_func

# Special repo status function for git and svn
__repo_ps1 () {
	local info=$(svn info 2> /dev/null)
	
	# if not a svn repo, then try the git method
	if [[ -z "$info" ]] ; then
		echo -n "$(__git_ps1)"
		return
	fi
	
	# if it is a svn repo, then strip info out of it
	local svnrev=$(echo "$info" | awk '/Revision:/ {print $2}')
	local flag=
	
	# if we want to show dirty state then exec svn status
	if [ $SVN_PS1_SHOWDIRTYSTATE ] ; then
		local state=$(svn status --ignore-externals "$(echo "$info" | sed -n "s/Working Copy Root Path: \(.\+\)/\1/p")" 2> /dev/null)
		
		# make the file status conditions unique if there are changes
		if [ -n "$state" ]; then
			flag=" *$(echo "$state" | awk '{print $1}' | uniq | sort | tr -d '\n')"
		fi
	fi
	
	echo -n " ($svnrev$flag)"
}

cf() {
	find "$1" -type f | wc -l
}

trim () {
	echo "$1";
}

findhere () {
	find . -iname "$1"
}

execlist () {
	if [[ "$1" =~ "{}" ]] ; then
		ls -1 | xargs -I {} -P $PROC_CORES sh -c "$1"
	else
		echo "Missing argument identifier {}."
	fi
}

execfind () {
	if [[ -n "$1" ]] ; then
		if [[ "$2" =~ "{}" ]] ; then
			find . -iname "$1" | xargs -I {} -P $PROC_CORES sh -c "$2"
		else
			echo "Missing argument identifier {}."
		fi
	else
		echo "Missing search term."
	fi
}

execcat () {
	if [[ ( -n "$1" ) && ( -f "$1" ) ]] ; then
		if [[ "$2" =~ "{}" ]] ; then
			cat "$1" | tr -d '\r' | xargs -I {} -P $PROC_CORES -r sh -c "$2"
		else
			echo "Missing argument identifier {}."
		fi
	else
		echo "File not found."
	fi
}

alias els='execlist'
alias efind='execfind'
alias ecat='execcat'