#!/usr/bin/env bash
# Installs pi-vm: checks the prerequisites, links pi-vm onto your PATH, writes a starter config,
# installs the pi-handoff skill for Claude Code, asks for your OpenRouter key, builds the VM image
# and runs a smoke test inside it. Safe to run again: it updates what is there.
#
#   ./install.sh              install or update
#   ./install.sh --no-build   skip building the image (e.g. it is already built)
#   ./install.sh --container  no microVM: run pi in a plain podman container (less isolation)
#   ./install.sh --uninstall  remove the link, the skill, the image and the caches
#                             (keeps your config, your key and any runs)
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
BIN_DIR=${PI_VM_BIN_DIR:-$HOME/.local/bin}
SKILLS_DIR=${PI_VM_SKILLS_DIR:-$HOME/.claude/skills}
CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}/pi-vm/config
KEY_FILE=$HOME/.bashrc.d/openrouter.sh
IMAGE=localhost/pi-vm:latest

build=1 runtime=krun uninstall=0
for arg in "$@"; do
  case $arg in
    --no-build) build=0 ;;
    --container) runtime=crun ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,11s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then b=$'\e[1m' g=$'\e[32m' y=$'\e[33m' r=$'\e[31m' n=$'\e[0m'; else b= g= y= r= n=; fi
step() { echo "${b}==> $*${n}"; }
ok()   { echo "    ${g}ok${n} $*"; }
warn() { echo "    ${y}!${n} $*"; }
fail() { echo "    ${r}x${n} $*" >&2; missing=1; }

if (( uninstall )); then
  step "Uninstalling pi-vm"
  [[ -L $BIN_DIR/pi-vm ]] && rm -f -- "$BIN_DIR/pi-vm" && ok "removed $BIN_DIR/pi-vm"
  [[ -d $SKILLS_DIR/pi-handoff ]] && rm -rf -- "$SKILLS_DIR/pi-handoff" && ok "removed the pi-handoff skill"
  if command -v podman >/dev/null; then
    podman image rm -f "$IMAGE" >/dev/null 2>&1 && ok "removed the image"
    podman volume rm -f pi-vm-npm pi-vm-cache >/dev/null 2>&1 && ok "removed the cache volumes"
  fi
  echo "Kept: $CONFIG, $KEY_FILE, and runs in ~/.cache/pi-vm (delete them by hand if you like)."
  exit 0
fi

# Distro-specific install hints for what's missing.
. /etc/os-release 2>/dev/null || true
hint() {
  case "${ID:-} ${ID_LIKE:-}" in
    *fedora*|*rhel*) echo "sudo dnf install $1" ;;
    *debian*|*ubuntu*) echo "sudo apt install $2" ;;
    *arch*) echo "sudo pacman -S $3" ;;
    *) echo "install $2 with your package manager" ;;
  esac
}

step "Checking prerequisites"
missing=0
[[ $(uname -s) == Linux ]] || { echo "pi-vm needs Linux (KVM + podman)." >&2; exit 1; }
for tool in git curl jq podman; do
  if command -v "$tool" >/dev/null; then ok "$tool"; else fail "$tool missing: $(hint "$tool" "$tool" "$tool")"; fi
done
if [[ $runtime == krun ]]; then
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then ok "/dev/kvm"
  else fail "/dev/kvm is missing or not usable by you (enable virtualization in the BIOS; add yourself to the kvm group)"; fi
  if command -v krun >/dev/null; then ok "krun (libkrun runtime for podman)"
  else
    fail "krun missing: $(hint crun-krun "crun with libkrun (often not packaged; see https://github.com/containers/libkrun)" crun-krun)"
    echo "      Or install without the microVM: ./install.sh --container (pi then runs in a plain container)"
  fi
fi
(( missing )) && { echo "Install what's missing above, then run ./install.sh again." >&2; exit 1; }

step "Linking pi-vm into $BIN_DIR"
mkdir -p -- "$BIN_DIR"
chmod +x "$here/bin/pi-vm" "$here/image/pi-run"
ln -sfn -- "$here/bin/pi-vm" "$BIN_DIR/pi-vm"
ok "$BIN_DIR/pi-vm -> $here/bin/pi-vm"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on your PATH; add it in your shell's rc file" ;; esac

step "Config"
if [[ -f $CONFIG ]]; then ok "keeping $CONFIG"
else
  mkdir -p -- "$(dirname -- "$CONFIG")"
  cp -- "$here/config.example" "$CONFIG"
  ok "wrote $CONFIG (default model xiaomi/mimo-v2.6-flash, thinking low)"
fi
if [[ $runtime == crun ]]; then
  grep -q '^PI_VM_RUNTIME=' "$CONFIG" && sed -i 's/^PI_VM_RUNTIME=.*/PI_VM_RUNTIME=crun/' "$CONFIG" \
    || printf '\n# Installed with --container: no microVM, pi runs in a plain podman container.\nPI_VM_RUNTIME=crun\n' >>"$CONFIG"
  warn "container mode: pi runs in a rootless container, not a VM; it shares your kernel"
fi

step "Claude Code skill"
if [[ -d $HOME/.claude || -d $SKILLS_DIR ]]; then
  mkdir -p -- "$SKILLS_DIR"
  rm -rf -- "$SKILLS_DIR/pi-handoff"
  cp -r -- "$here/skills/pi-handoff" "$SKILLS_DIR/"
  ok "installed $SKILLS_DIR/pi-handoff (say \"hand it off to pi\" in Claude Code)"
else
  warn "no ~/.claude found; skipping the skill. Copy skills/pi-handoff to ~/.claude/skills/ later."
fi

step "OpenRouter key"
if [[ -n ${OPENROUTER_API_KEY:-} || -f $KEY_FILE ]]; then
  if [[ -n ${OPENROUTER_API_KEY:-} ]]; then ok "found in your environment"; else ok "found in $KEY_FILE"; fi
elif [[ -t 0 ]]; then
  echo "    Get one at https://openrouter.ai/keys (set a credit limit on it)."
  "$here/bin/pi-vm" set-key
else
  warn "not set; run: pi-vm set-key"
fi
if [[ -f $KEY_FILE ]] && ! grep -qs 'bashrc.d' "$HOME/.bashrc"; then
  warn "your ~/.bashrc doesn't source ~/.bashrc.d/; add:  source $KEY_FILE"
fi

if (( build )); then
  step "Building the VM image (a few minutes the first time, ~2.5 GB)"
  "$here/bin/pi-vm" build
  ok "built $IMAGE"
else
  podman image exists "$IMAGE" && ok "skipping build; $IMAGE exists" \
    || warn "skipping build, but $IMAGE doesn't exist yet: run pi-vm build"
fi

if podman image exists "$IMAGE"; then
  step "Smoke test ($runtime)"
  if v=$(podman run --rm --runtime "$runtime" "$IMAGE" pi --version 2>&1); then
    ok "pi $v runs inside the $([[ $runtime == krun ]] && echo microVM || echo container)"
  else
    echo "$v" | tail -5 >&2
    echo "    ${r}x${n} the image didn't start with --runtime $runtime" >&2
    exit 1
  fi
fi

cat <<EOF

${b}pi-vm is installed.${n}
  pi-vm model                 show the default model and its price
  pi-vm model <openrouter-id> check another model
  In Claude Code:             "hand it off to pi"  (or "... with <model>")

Start Claude Code from a new shell so it sees OPENROUTER_API_KEY. If Claude Code runs as a service
(systemd, launchd), the key must be in that service's environment too.
EOF
