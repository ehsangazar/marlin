# Marlin shell integration for zsh.
#
#   echo 'source ~/Projects/merge/marlin/shell/marlin.zsh' >> ~/.zshrc
#
# Emits the standard semantic prompt marks (OSC 133) and the working directory
# (OSC 7). Marlin reads these; it never parses your command line. That division
# is the whole reason autosuggestions, completion and history stay your shell's
# job and stay fast.

[[ -n "$MARLIN_SHELL_INTEGRATION" ]] && return
export MARLIN_SHELL_INTEGRATION=1

__marlin_cwd() { printf '\033]7;file://%s%s\033\\' "$HOST" "$PWD" }

__marlin_prompt_start()  { printf '\033]133;A\033\\' }
__marlin_prompt_end()    { printf '\033]133;B\033\\' }
__marlin_preexec()       { printf '\033]133;C\033\\' }
__marlin_precmd()        { printf '\033]133;D;%s\033\\' "$?"; __marlin_cwd }

autoload -Uz add-zsh-hook
add-zsh-hook precmd  __marlin_precmd
add-zsh-hook preexec __marlin_preexec

PS1='%{$(__marlin_prompt_start)%}'"$PS1"'%{$(__marlin_prompt_end)%}'
__marlin_cwd
