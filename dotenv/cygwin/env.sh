# make sure sbin is included
[[ -d "/usr/sbin" ]] && PATH="${PATH}:/usr/sbin"

# set default editor to notepad++
if type npp &> /dev/null; then
  export EDITOR="npp"
fi

# Remove the windows version of node & npm from the path so we can use the wrapped version
PATH=$(echo "$PATH" | sed "s/\/c\/Program Files\/nodejs\/\?:\?//")
PATH=$(echo "$PATH" | sed "s/$(cygpath --homeroot | sed 's#\/#\\\/#g')\/$USER\/AppData\/Roaming\/npm\/\?:\?//")

# add npm & nodejs to path if possible
if [[ -d "$(cygpath --homeroot)/$USER/AppData/Roaming/npm" ]]; then
  NODE_BIN_PATH=$(cygpath -u "c:/Program Files/nodejs")
  # for looking up global variables
  export NODE_PATH=$(cygpath -wa "$(cygpath --homeroot)/$USER/AppData/Roaming/npm")
  export NODE_BIN_PATH
  PATH="$PATH:$NODE_BIN_PATH:$(cygpath --homeroot)/$USER/AppData/Roaming/npm"
  function npm() {
    local NPM_APPDATA=$APPDATA
    local NPM_LOCALAPPDATA=$LOCALAPPDATA
    local NPM_TMP=$TMP
    local NPM_TEMP=$TEMP
    local NPM_CMD
    local NPM_RUN_PATH=$PATH

    # if we want to run npm install/update with git paths, cygwin git
    # cannot handle the windows paths, so instead we must rely on a wrapper
    # to be installed
    NPM_RUN_PATH="$DOTFILES__ROOT/.dotenv/cygwin/npm-fix:$PATH"

    # add the proper APPDATA directory
    if [[ -d "$(cygpath --homeroot)/$USER/AppData/Roaming" ]]; then
      NPM_APPDATA="$(cygpath -w "$(cygpath --homeroot)/$USER/AppData/Roaming")"
    else
      NPM_APPDATA="$(cygpath -w "$NODE_BIN_PATH")"
    fi

    if [[ -d "$(cygpath --homeroot)/$USER/AppData/Local" ]]; then
      NPM_LOCALAPPDATA="$(cygpath -w "$(cygpath --homeroot)/$USER/AppData/Local")"
    fi

    # use the windows %TMP% and %TEMP% dirs
    if [[ -d "$(cygpath --homeroot)/$USER/AppData/Local/Temp" ]]; then
      NPM_TMP="$(cygpath -w "$(cygpath --homeroot)/$USER/AppData/Local/Temp")"
      NPM_TEMP="$(cygpath -w "$(cygpath --homeroot)/$USER/AppData/Local/Temp")"
    fi

    # make sure we're using the latest npm command
    if [[ -f "$(cygpath --homeroot)/$USER/AppData/Roaming/npm/npm.cmd" ]]; then
      NPM_CMD="$(cygpath --homeroot)/$USER/AppData/Roaming/npm/npm.cmd"
    else
      NPM_CMD="${NODE_BIN_PATH%/}/npm.cmd"
    fi

    TMP="$NPM_TMP" \
    TEMP="$NPM_TEMP" \
    APPDATA="$NPM_APPDATA" \
    LOCALAPPDATA="$NPM_LOCALAPPDATA" \
    PATH="$NODE_BIN_PATH:$(cygpath --homeroot)/$USER/AppData/Roaming/npm/:$(cygpath --unix c:)/Python27/:$NPM_RUN_PATH" \
      winpty "$NPM_CMD" "$@"
  }
  export -f npm
fi
