#!/bin/sh

set -eu

say() {
  printf 'patchdesk install: %s\n' "$*" >&2
}

fail() {
  say "$*"
  exit 1
}

run_in_dir() (
  directory=$1
  shift
  if [ -w "$directory" ]; then
    "$@"
  else
    sudo "$@"
  fi
)

main() {
[ "$#" -eq 0 ] || fail 'This installer takes no arguments.'
[ "$(uname -s)" = Darwin ] || fail 'macOS is required.'
[ "$(uname -m)" = arm64 ] || fail 'An Apple Silicon Mac is required.'
for tool in curl plutil shasum ditto mktemp xattr; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required."
done

install_dir=${PATCHDESK_INSTALL_DIR:-/Applications}
bin_dir=${PATCHDESK_BIN_DIR:-/usr/local/bin}
case "$install_dir" in /*) ;; *) fail 'PATCHDESK_INSTALL_DIR must be an absolute path.' ;; esac
case "$bin_dir" in /*) ;; *) fail 'PATCHDESK_BIN_DIR must be an absolute path.' ;; esac
[ -d "$install_dir" ] || fail "Install folder does not exist: $install_dir"

app_path=$install_dir/Patchdesk.app
bin_path=$bin_dir/patchdesk
if [ -e "$app_path" ] || [ -L "$app_path" ]; then
  fail "Patchdesk is already installed at $app_path. Choose how to update that installation."
fi
if [ -e "$bin_path" ] || [ -L "$bin_path" ]; then
  fail "Command path already exists: $bin_path"
fi

if [ ! -w "$install_dir" ] || { [ -d "$bin_dir" ] && [ ! -w "$bin_dir" ]; }; then
  command -v sudo >/dev/null 2>&1 || fail 'sudo is required to write to the install folders.'
fi

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/patchdesk-install.XXXXXX")
staging_path=
app_installed=0
bin_linked=0
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$result" -ne 0 ]; then
    if [ "$bin_linked" -eq 1 ]; then
      run_in_dir "$bin_dir" rm -f "$bin_path" || :
    fi
    if [ "$app_installed" -eq 1 ]; then
      run_in_dir "$install_dir" rm -rf "$app_path" || :
    fi
  fi
  if [ -n "$staging_path" ] && [ -e "$staging_path" ]; then
    run_in_dir "$install_dir" rm -rf "$staging_path" || :
  fi
  rm -rf "$temp_dir" || :
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

release_json=$temp_dir/release.json
curl -fsSL --output "$release_json" \
  https://api.github.com/repos/kwanpham2195/patchdesk/releases/latest \
  || fail 'Could not read the latest Patchdesk release.'
tag=$(plutil -extract tag_name raw -o - "$release_json") \
  || fail 'The release has no tag.'
printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "Unexpected release tag: $tag"
version=${tag#v}
asset_name=Patchdesk-$version-arm64-mac.zip

index=0
digest=
while [ "$index" -lt 100 ]; do
  name=$(plutil -extract "assets.$index.name" raw -o - "$release_json" 2>/dev/null) || break
  if [ "$name" = "$asset_name" ]; then
    digest=$(plutil -extract "assets.$index.digest" raw -o - "$release_json") \
      || fail "The release has no digest for $asset_name."
    break
  fi
  index=$((index + 1))
done
printf '%s\n' "$digest" | grep -Eq '^sha256:[[:xdigit:]]{64}$' \
  || fail "The release has no SHA-256 digest for $asset_name."
expected_sha=${digest#sha256:}

archive=$temp_dir/$asset_name
say "Downloading Patchdesk $version for Apple Silicon."
curl -fsSL --output "$archive" \
  "https://github.com/kwanpham2195/patchdesk/releases/download/$tag/$asset_name" \
  || fail "Could not download $asset_name."
actual_sha=$(shasum -a 256 "$archive") || fail 'Could not hash the download.'
actual_sha=${actual_sha%% *}
[ "$actual_sha" = "$expected_sha" ] || fail 'Download checksum does not match the release.'

unpacked=$temp_dir/unpacked
mkdir "$unpacked"
ditto -x -k "$archive" "$unpacked" || fail 'Could not unpack the download.'
source_app=$unpacked/Patchdesk.app
[ -f "$source_app/Contents/MacOS/Patchdesk" ] \
  || fail 'The download does not contain Patchdesk.app.'
[ -f "$source_app/Contents/Resources/bin/patchdesk" ] \
  || fail 'The download does not contain the patchdesk command.'

if [ ! -d "$bin_dir" ]; then
  bin_parent=${bin_dir%/*}
  if [ -d "$bin_parent" ]; then
    run_in_dir "$bin_parent" mkdir "$bin_dir" || fail "Could not create $bin_dir."
  else
    command -v sudo >/dev/null 2>&1 || fail "sudo is required to create $bin_dir."
    sudo mkdir -p "$bin_dir" || fail "Could not create $bin_dir."
  fi
fi

candidate_staging_path=$install_dir/.Patchdesk.app.installing.$$
[ ! -e "$candidate_staging_path" ] || fail "Install staging path already exists: $candidate_staging_path"
staging_path=$candidate_staging_path
run_in_dir "$install_dir" ditto "$source_app" "$staging_path" \
  || fail 'Could not copy Patchdesk into Applications.'
run_in_dir "$install_dir" mv -n "$staging_path" "$app_path" \
  || fail 'Could not finish installing Patchdesk.'
[ ! -e "$staging_path" ] || fail "Another Patchdesk app appeared at $app_path."
staging_path=
app_installed=1

if xattr -p com.apple.quarantine "$app_path" >/dev/null 2>&1; then
  say 'Clearing the download quarantine flag because this release is not notarized.'
  run_in_dir "$install_dir" xattr -dr com.apple.quarantine "$app_path" \
    || fail 'Could not clear the download quarantine flag.'
fi

run_in_dir "$bin_dir" ln -s "$app_path/Contents/Resources/bin/patchdesk" "$bin_path" \
  || fail "Could not link the patchdesk command in $bin_dir."
bin_linked=1
say "Installed Patchdesk $version at $app_path."
say 'Open Patchdesk, then choose your checkout folder and repositories.'
}

main "$@"
