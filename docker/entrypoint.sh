#!/bin/sh
set -eu

GIT_USER_NAME="${GIT_USER_NAME:-Actuarius Bot}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-actuarius-bot@users.noreply.github.com}"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
mkdir -p "$NPM_CONFIG_PREFIX"

/app/install-llm-user-instructions.sh
/app/seed-provider-clis.sh

if [ ! -f "$HOME/.gemini/settings.json" ]; then
  cat <<EOF > "$HOME/.gemini/settings.json"
{
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  }
}
EOF
fi

git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

if [ -n "${GH_TOKEN:-}" ]; then
  git config --global --replace-all credential.https://github.com.helper \
    '!f() { echo username=x-token; printf "password=%s\n" "$GH_TOKEN"; }; f'
fi

exec "$@"
