# Sourced via `bash --rcfile` for each console session shell.

# ---------------------
# Bash prompt
# ---------------------
# Defined + exported BEFORE sourcing ~/.bashrc and BEFORE any prompt expansion,
# because parent shells (e.g. iTerm shell integration) often export a PS1 that
# references parse_git_branch — without this, /etc/bashrc and any sub-shells
# spawn warnings like `bash: parse_git_branch: command not found`.
function parse_git_branch {
  git branch --no-color 2> /dev/null | sed -e '/^[^*]/d' -e 's/* \(.*\)/(\1)/'
}
export -f parse_git_branch

# Pull in the user's normal interactive config, then our prompt.
[ -f ~/.bashrc ] && source ~/.bashrc

function proml {
  local        BLUE="\[\033[0;34m\]"
  local         RED="\[\033[0;31m\]"
  local   LIGHT_RED="\[\033[1;31m\]"
  local       GREEN="\[\033[0;32m\]"
  local LIGHT_GREEN="\[\033[1;32m\]"
  local       WHITE="\[\033[1;37m\]"
  local  LIGHT_GRAY="\[\033[0;37m\]"
  case $TERM in
    xterm*)
    TITLEBAR='\[\033]0;\u@\h:\w\007\]'
    ;;
    *)
    TITLEBAR=""
    ;;
  esac

PS1="${TITLEBAR}\
$BLUE[$RED\$(date +%H:%M)$BLUE]\
$BLUE[$RED\u@\h:\w$GREEN\$(parse_git_branch)$BLUE]\
$GREEN\$ "
PS2='> '
PS4='+ '
}
proml

# ---------------------
# Shell running/idle indicator via OSC-133 shell-integration markers. The
# tabterm proxy watches the PTY stream for these and toggles the session's
# status in the sidebar.
#   ESC ]133;A ST  prompt start  → idle
#   ESC ]133;C ST  command start → running
#   ESC ]133;D ST  command done  → idle
# Skipped for "claude" sessions: there the whole claude binary is the foreground
# command, so OSC-133 would just say "running forever". Claude reports its own
# turn boundaries via the UserPromptSubmit / Stop hooks instead.
# ---------------------
if [ -z "$STARTUP_COMMAND" ]; then
  _tabterm_preexec() { printf '\e]133;C\e\\'; }
  _tabterm_precmd()  { printf '\e]133;D\e\\\e]133;A\e\\'; }
  PROMPT_COMMAND="_tabterm_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  trap '_tabterm_preexec' DEBUG
fi

# ---------------------
# Optional startup command (set by tabterm for AI sessions). $STARTUP_SESSION_ID
# pins this shell to a specific conversation UUID so each tab resumes its own
# conversation instead of `--continue`-ing whichever was most-recently touched
# in this cwd. We can't blindly --resume: claude errors with "No conversation
# found" if the UUID has no .jsonl yet (e.g. user never typed anything on the
# previous launch). And we can't blindly --session-id: claude errors with
# "already in use" once a .jsonl exists. So inspect claude's project store and
# pick the right flag for this launch. When the command exits the user falls
# back to interactive bash.
# ---------------------
if [ -n "$STARTUP_COMMAND" ]; then
  if [ -n "$STARTUP_SESSION_ID" ]; then
    PROJECT_KEY="${PWD//[\/.]/-}"
    if [ -f "$HOME/.claude/projects/$PROJECT_KEY/$STARTUP_SESSION_ID.jsonl" ]; then
      eval "$STARTUP_COMMAND --resume $STARTUP_SESSION_ID"
    else
      eval "$STARTUP_COMMAND --session-id $STARTUP_SESSION_ID"
    fi
  else
    eval "$STARTUP_COMMAND"
  fi
fi
