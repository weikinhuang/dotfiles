# include solarized dir colors theme
[[ -n "$__term_solarized_light" ]] && type dircolors &> /dev/null && eval "$(dircolors "${DOTFILES__ROOT}/.dotenv/other/dircolors.solarized.ansi-light")"

# include special mysql client customizations
source "${DOTFILES__ROOT}/.dotenv/other/mysql-client.sh"

# include git __git_ps1 if not already included elsewhere
type __git_ps1 &> /dev/null || source "${DOTFILES__ROOT}/.dotenv/other/git-prompt.sh"
