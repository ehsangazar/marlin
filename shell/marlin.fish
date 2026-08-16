# Marlin shell integration for fish.
#
#   echo 'source "/Applications/Marlin.app/Contents/Resources/shell/marlin.fish"' >> ~/.config/fish/config.fish
#
# or, from a clone:
#
#   echo "source $PWD/shell/marlin.fish" >> ~/.config/fish/config.fish

if set -q MARLIN_SHELL_INTEGRATION
    exit
end
set -gx MARLIN_SHELL_INTEGRATION 1

function __marlin_cwd --on-variable PWD
    printf '\033]7;file://%s%s\033\\' (hostname) "$PWD"
end

function __marlin_preexec --on-event fish_preexec
    printf '\033]133;C\033\\'
end

function __marlin_postexec --on-event fish_postexec
    printf '\033]133;D;%s\033\\' $status
end

function __marlin_prompt --on-event fish_prompt
    printf '\033]133;A\033\\'
end

__marlin_cwd
