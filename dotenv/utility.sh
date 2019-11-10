# shellcheck shell=bash
# include solarized dir colors theme
[[ -n "${__term_solarized_light}" ]] && type dircolors &> /dev/null && eval $(dircolors "${DOTFILES__ROOT}/.dotfiles/dotenv/other/dircolors.solarized.ansi-light")
[[ -n "${__term_solarized_256}" ]] && type dircolors &> /dev/null && eval $(dircolors "${DOTFILES__ROOT}/.dotfiles/dotenv/other/dircolors.solarized.256dark")

# include special mysql client customizations
source "${DOTFILES__ROOT}/.dotfiles/dotenv/other/mysql-client.sh"

# include git __git_ps1 if not already included elsewhere
type __git_ps1 &> /dev/null || source "${DOTFILES__ROOT}/.dotfiles/dotenv/other/git-prompt.sh"
