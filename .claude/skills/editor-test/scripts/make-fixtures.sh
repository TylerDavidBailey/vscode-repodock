#!/usr/bin/env bash
# Builds the sample repositories the scenarios run against, inside a throwaway home
# directory under the work dir. The editors are launched with HOME pointing there, so
# RepoDock shows ~/projects and ~/work and nothing in the real home is read or written.
#
# Re-running is a no-op once the fixtures exist; pass --reset to rebuild them from scratch.
set -euo pipefail

E2E_DIR="${REPODOCK_E2E_DIR:-/tmp/repodock-e2e}"
H="$E2E_DIR/home"
MARKER="$H/.repodock-fixtures"

if [ -e "$H" ]; then
  if [ "${1:-}" != "--reset" ]; then
    echo "fixtures already exist at $H (pass --reset to rebuild)"
    exit 0
  fi
  # the marker proves this directory is one this script made, not a path typed by mistake
  if [ ! -e "$MARKER" ]; then
    echo "refusing to reset $H: it has no $(basename "$MARKER") marker" >&2
    exit 1
  fi
  rm -rf "$H"
fi

mkdir -p "$H"
touch "$MARKER"

# fixed identity and no user config, so the fixtures come out the same on every machine
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.com
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

REMOTES="$H/.fixture-remotes"
mkdir -p "$REMOTES"
CLONES=0

# make_repo <path> <branch> <modified> <untracked> <ahead> <behind> <has-upstream: 1|0>
make_repo() {
  local path=$1 branch=$2 modified=$3 untracked=$4 ahead=$5 behind=$6 upstream=$7 i
  mkdir -p "$path"
  cd "$path"
  git init -q -b "$branch"
  for i in 1 2 3 4 5 6; do echo "v1" >"file$i.ts"; done
  git add -A
  git commit -q -m "initial"
  if [ "$upstream" = 1 ]; then
    local remote="$REMOTES/$(echo "${path#"$H"/}" | tr '/ ' '__').git"
    git clone -q --bare . "$remote"
    git remote add origin "$remote"
    git fetch -q origin
    git branch -q --set-upstream-to="origin/$branch"
    if [ "$behind" -gt 0 ]; then
      # commits pushed from a second clone are what put this checkout behind its upstream
      CLONES=$((CLONES + 1))
      local other="$REMOTES/clone-$CLONES"
      git clone -q "$remote" "$other"
      for i in $(seq 1 "$behind"); do
        echo "$i" >>"$other/upstream.txt"
        git -C "$other" add -A
        git -C "$other" commit -q -m "upstream $i"
      done
      git -C "$other" push -q origin "$branch"
      git fetch -q origin
    fi
    for i in $(seq 1 "$ahead"); do
      echo "$i" >>local.txt
      git add -A
      git commit -q -m "local $i"
    done
  fi
  for i in $(seq 1 "$modified"); do echo "changed" >>"file$i.ts"; done
  for i in $(seq 1 "$untracked"); do echo "new" >"scratch$i.tmp"; done
}

# --- ~/projects and ~/work: the everyday set ----------------------------------------------
#         path                                                   branch                              M U ahead behind upstream
make_repo "$H/projects/web/storefront"                           feat/checkout-redesign              3 2 2 1 1
make_repo "$H/projects/web/admin-dashboard"                      release/v2.1.0                      0 0 0 0 1
make_repo "$H/projects/web/playground"                           main                                0 0 0 0 1
make_repo "$H/projects/services/user-service"                    main                                0 0 0 4 1
make_repo "$H/projects/services/payments-api"                    fix/retry-webhooks                  5 1 1 0 1
make_repo "$H/projects/services/api-gateway"                     main                                1 0 0 0 1
make_repo "$H/projects/services/api-gateway/vendor/shared-utils" main                                0 0 0 0 0
make_repo "$H/projects/tools/deploy-cli"                         develop                             0 3 0 0 1
make_repo "$H/projects/tools/experiments/playground"             main                                0 0 0 0 0
make_repo "$H/projects/dev-setup"                                main                                0 0 3 0 1
make_repo "$H/work/clients/client-portal"                        feature/sso-login-redirect-handling 2 0 0 0 1
make_repo "$H/work/clients/reporting-api"                        main                                0 0 0 2 1
make_repo "$H/work/infrastructure"                               main                                0 0 0 0 1
git -C "$H/projects/tools/experiments/playground" checkout -q --detach

# --- ~/edge: one repo per awkward case ----------------------------------------------------
make_repo "$H/edge/name with spaces"                 main 0 0 0 0 0
make_repo "$H/edge/ünïcødé-repo"                     main 0 0 0 0 0
# markdown in a name must reach the tooltip as literal text, never as formatting or a link
make_repo "$H/edge/*not-bold*_[link](x)"             main 0 0 0 0 0
make_repo "$H/edge/node_modules/inside-excluded"     main 0 0 0 0 0
# with ~/edge as the scan root, at-limit sits exactly at the default maxDepth of 4
make_repo "$H/edge/deep/a/b/at-limit"                main 0 0 0 0 0
make_repo "$H/edge/deep/a/b/c/d/too-deep"            main 0 0 0 0 0
# no commits yet, so HEAD points at a branch that does not exist
mkdir -p "$H/edge/empty-repo"
git -C "$H/edge/empty-repo" init -q -b main
# a linked worktree has a .git file rather than a .git directory
git -C "$H/edge/name with spaces" worktree add -q "$H/edge/linked-worktree" -b worktree-branch
# has no .git entry of its own, so it is not a repository RepoDock can open
git init -q --bare "$H/edge/bare.git"
# symlinked directories are not followed, so nothing under ~/work may show up through this
ln -s "$H/work" "$H/edge/link-to-work"

# --- ~/empty: a folder with no repositories at all --------------------------------------
mkdir -p "$H/empty/just-a-folder"

# --- ~/many: enough repositories to scroll and to notice a slow scan ----------------------
make_repo "$H/many/repo-001" main 0 0 0 0 0
for i in $(seq -w 2 150); do cp -r "$H/many/repo-001" "$H/many/repo-$i"; done

echo "fixtures ready at $H"
