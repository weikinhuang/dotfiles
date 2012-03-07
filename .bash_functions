dusort() {
	du -ka --max-depth=$1 | sort -nr | cut -f2 | xargs -d '\n' du -sh
}

cf() {
	find "$1" -type f | wc -l
}

trim () {
	echo $1;
}

findhere () {
	find . -iname "$1"
}