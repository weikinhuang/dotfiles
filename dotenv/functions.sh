# Special cd replacement that shows up to the last 10 directories with 'cd --'.
function __cd_func() {
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

	# '~' has to be substituted by ${HOME}
	[[ ${the_new_dir:0:1} == '~' ]] && the_new_dir="${HOME}${the_new_dir:1}"

	# Now change to the new dir and add to the top of the stack
	pushd "${the_new_dir}" > /dev/null
	[[ $? -ne 0 ]] && return 1
	the_new_dir=$(pwd)

	# Trim down everything beyond 11th entry
	popd -n +11 2>/dev/null 1>/dev/null

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

# push a command to the prompt command
function __push_prompt_command() {
	local command="${1/%;/}"
	PROMPT_COMMAND="$(echo "$(echo "${PROMPT_COMMAND/%;/}" | tr ';' '\n' | grep -v -F "$command" | grep -v '^ *$' | tr '\n' ';')${command};" | sed 's/;;/;/' | sed 's/^;//')"
}

# Count the number of files in a directory
function cf() {
	find "${1-.}" -type f | wc -l
}

# find files with case-insensetive matching in current directory
function findhere() {
	find . -iname "*$1*"
}

# do a case-insensetive grep on all the files in a directory
function grip() {
	grep -ir "$1" .
}

# xargs wrapper for running PROC_CORES parallel processes
function parallel-xargs () {
	local cmd="$*"
	if [[ ! "$cmd" =~ "{}" ]] ; then
		cmd="$cmd {}"
	fi
	xargs -r -I {} -P $PROC_CORES sh -c "$cmd"
}

# Extract archives automatically
function extract () {
	if [ -f "$1" ] ; then
		case "$1" in
		*.tar.bz2)
			tar xjf "$@"
			;;
		*.tar.gz)
			tar xzf "$@"
			;;
		*.bz2)
			bunzip2 "$@"
			;;
		*.rar)
			rar x "$@"
			;;
		*.gz)
			gunzip "$@"
			;;
		*.tar)
			tar xf "$@"
			;;
		*.tbz2)
			tar xjf "$@"
			;;
		*.tgz)
			tar xzf "$@"
			;;
		*.zip)
			unzip "$@"
			;;
		*.Z)
			uncompress "$@"
			;;
		*.7z)
			7z x "$@"
			;;
		*)
			echo "'$1' cannot be extracted via extract()"
			;;
		esac
	else
		echo "'$1' is not a valid file"
	fi
}

# Get gzipped file size
function gz() {
	echo -n "original (bytes): "
	cat "$1" | wc -c
	echo -n "gzipped (bytes):  "
	gzip -c "$1" | wc -c
}

# Create a new directory and enter it
function md() {
	mkdir -p "$@" && cd "$@"
}

# Use Git's colored diff when available
if type git &> /dev/null; then
	function diff() {
		git diff --no-index --color "$@"
	}
fi

# Create a data URL from an image (works for other file types too, if you tweak the Content-Type afterwards)
function dataurl() {
	echo "data:image/${1##*.};base64,$(openssl base64 -in "$1")" | tr -d '\n'
}

# Gzip-enabled `curl`
function gcurl() {
	curl -sH "Accept-Encoding: gzip" "$@" | gunzip
}

# Escape UTF-8 characters into their 3-byte format
function escape() {
	printf "\\\x%s" $(printf "$@" | xxd -p -c1 -u)
	echo # newline
}

# Decode \x{ABCD}-style Unicode escape sequences
function unidecode() {
	perl -e "binmode(STDOUT, ':utf8'); print \"$@\""
	echo # newline
}

# Get a character's Unicode code point
function codepoint() {
	perl -e "use utf8; print sprintf('U+%04X', ord(\"$@\"))"
	echo # newline
}

# Convert a unix timestamp to a date string
function unix2date() {
	if [[ -n "$1" ]] ; then
		echo "$1" | awk '{print strftime("%c", $1)}'
		return
	fi
	date
}

# Convert a date string to a unix timestamp
function date2unix() {
	if [[ -n "$1" ]] ; then
		date --date "$*" +%s
		return
	fi
	date +%s
}

# Convert to lowercase.
function lc () {
	tr '[:upper:]' '[:lower:]'
}

# Convert to uppercase.
function uc () {
	tr '[:lower:]' '[:upper:]'
}

# regex match and replace from: https://gist.github.com/opsb/4409156
function regex () {
	gawk 'match($0, '$1', ary) { print ary['${2:-'0'}'] }';
}

# binary diff
function binarydiff () {
	vimdiff <(xxd "$1") <(xxd "$2")
}
