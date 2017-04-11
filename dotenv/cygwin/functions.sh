# Open a Windows (Vista/7/8) Libraries
function olib() {
  if [[ -z "$1" ]] ; then
    return 1
  fi
  local library="$(cygpath --homeroot)/$(whoami)/AppData/Roaming/Microsoft/Windows/Libraries/$1.library-ms"
  if [[ ! -e "$library" ]] ; then
    return 2
  fi
  open $library
  return $?
}

# Find processes by name match
function psfind() {
  local psout
  if [[ -n "$1" ]] ; then
    psout="$(ps -aW)"
    echo "${psout}" | head -n 1
    echo "${psout}" | grep -v "\\bSystem$" | grep -Pi "(\\\|/)[^\\/]*$1[^\\/]*(\.exe)?\$"
    return $?
  fi
  return 1
}

# Kill processes by name match
function pskill() {
  if [[ -n "${1}" ]] ; then
    ps -aW | grep -v "\\bSystem$" | grep -Pi "(\\\|/)[^\\/]*${1}[^\\/]*(\.exe)?\$" | awk '{ print $1 }' | xargs -r -I {} -P "${PROC_CORES:-1}" sh -c "/bin/kill -f {};"
    return $?
  fi
  return 1
}

# give the ability to wrap applications
function __cygexewrap() {
  local PROGRAM BINARY extraargs extraparams
  # the name of the program
  PROGRAM=$(cygpath -u "$1")
  BINARY="$2"
  extraparams=""

  if [[ ! -f "$PROGRAM" ]]; then
    echo "Application $1 does not exist."
    return 1
  fi

  if [[ -z "$BINARY" ]]; then
    echo "Function name missing."
    return 1
  fi

  # collect any extra arguments
  shift 2
  for extraargs in "$@"
  do
    extraparams="$extraparams "'"'$extraargs'"'
  done

  eval 'function '$BINARY'() {
    local args arg
    # if there are any baked in arguments they are defined here
    args=( '$extraparams' )

    for arg in "$@"
    do
      # if argument is a file, then expand it to windows paths
      if [ -e "$arg" ]
      then
        # echo "arg $arg is a file"
        args=("${args[@]}" "$(cygpath -w "$arg")")
      else
        # echo "arg $arg is not a file"
        args=("${args[@]}" "$arg")
      fi
    done

    # test if we are in a pipe and pass stdin as last argument if we are piping in
    if [ ! -t 0 ]
    then
      args=("${args[@]}" "$(cat -)");
    fi

    "'$PROGRAM'" "${args[@]}"
    return $?
  }'
  export -f $BINARY
}

# give the ability to wrap windows cli applications
if type winpty &> /dev/null; then
  function __cygcliwrap() {
    local PROGRAM BINARY extraargs extraparams
    # the name of the program
    PROGRAM=$(cygpath -u "$1")
    BINARY="$2"
    extraparams=""

    if [[ ! -f "$PROGRAM" ]]; then
      echo "Application $1 does not exist."
      return 1
    fi

    if [[ -z "$BINARY" ]]; then
      echo "Function name missing."
      return 1
    fi

    # collect any extra arguments
    shift 2
    for extraargs in "$@"
    do
      extraparams="$extraparams "'"'$extraargs'"'
    done

    eval 'function '$BINARY'() {
      local args arg
      # if there are any baked in arguments they are defined here
      args=( '$extraparams' )

      for arg in "$@"
      do
        # if argument is a file, then expand it to windows paths
        if [ -e "$arg" ]
        then
          # echo "arg $arg is a file"
          args=("${args[@]}" "$(cygpath -w "$arg")")
        else
          # echo "arg $arg is not a file"
          args=("${args[@]}" "$arg")
        fi
      done

      # test if we are in a pipe and pass stdin as last argument if we are piping in
      if [ ! -t 0 ]
      then
        "'$PROGRAM'" "${args[@]}" <<< "$(cat -)"
      else
        if [ ${#args[@]} -eq 0 ]
        then
          winpty "'$PROGRAM'" "${args[@]}"
        else
          "'$PROGRAM'" "${args[@]}"
        fi
      fi

      return $?
    }'
    export -f $BINARY
  }
else
  function __cygcliwrap() {
    echo "Package winpty required. Please visit https://github.com/rprichard/winpty and compile application."
  }
fi
