# pi-vm

Run Claude Code handoffs with [pi](https://pi.dev) inside a **microVM**, on any
[OpenRouter](https://openrouter.ai/models) model. Claude Code plans, pi executes with **full
access** inside a throwaway VM, and Claude Code verifies the result before anything touches your
repo.

The sibling of [dsh-vm](https://github.com/stansz/dsh-vm), which does the same with DeepSeek's dsh.
Same VM, same clone/apply flow; the differences are the agent (pi, a single agent with no
subagents) and the model, which is any OpenRouter model, chosen per run.

```
Claude Code (host) ── writes .handoff/plan.md
      │
      └─ pi-vm run ─▶ git clone --no-hardlinks → ~/.cache/pi-vm/runs/<repo>-<time>/
                       podman run --runtime krun   (own kernel, 2 GB, 2 CPUs, --rm)
                         ├─ the clone mounted at /work (virtiofs)
                         ├─ OPENROUTER_API_KEY + network
                         └─ pi --mode json --provider openrouter --model <id> --thinking <level>
      │
Claude Code (host) ── reviews the diff in the run dir, runs Acceptance there
      │
      └─ pi-vm apply ─▶ changes land in your repo as uncommitted changes → you commit
```

## Models

The default is `xiaomi/mimo-v2.6-flash` with thinking `low`. Change it in
`~/.config/pi-vm/config` (see `config.example`), or for one run:

```bash
pi-vm model                                   # show the default and its price
pi-vm model qwen/qwen3-coder                  # check a model exists, and its price
pi-vm run --model qwen/qwen3-coder --thinking medium "<prompt>"
```

In Claude Code, just say which model: "hand it off to pi with kimi". The skill finds the exact ID.

pi's built-in model list lags behind OpenRouter, so for every run pi-vm writes pi a `models.json`
for the chosen model from OpenRouter's own metadata (context size, max output, prices). Any model
on OpenRouter works, and pi's cost totals are right. The file lives next to the run dir, outside
the clone, so pi can't edit it mid-run.

**Routing.** OpenRouter serves most open models from several upstream providers, at different
quantizations. By default pi-vm asks for fp16/bf16/fp8 only, skipping fp4/int4 endpoints that are
cheaper but worse at long agentic runs. Set `PI_VM_ROUTING` to change that (`{}` for any endpoint).

## Logs and cost

pi runs in JSON-event mode. The raw events go to `.handoff/events.jsonl` in the run dir; a readable
log (commands run, files edited, the model's messages, tool errors) goes to
`.handoff/last-run.log`, which `pi-vm log` follows live. The log ends with the number of model
calls, tokens (fresh, cached and output) and the cost of the run. pi's JSON mode always exits 0,
so pi-vm exits non-zero when the last model call ended in an error.

## What the VM can and cannot reach

| Inside the VM | Not inside the VM |
|---|---|
| A clone of the repo (with `.handoff/`) | Your real checkout and its `.git` |
| `OPENROUTER_API_KEY` | SSH keys, `gh` token, any git remote: **it cannot push** |
| The network (OpenRouter, npm, web) | Your home directory and the rest of the host |
| The npm cache and `~/.cache` (podman volumes) | The host kernel (libkrun gives the VM its own) |

The key is the one secret inside, so give it a **credit limit** in OpenRouter's key settings.

pi runs as **root** inside the VM, so it can `dnf install` whatever a task needs. Under rootless
Podman that root is your own unprivileged user on the host. Chromium runs with `--no-sandbox`,
since the VM is the sandbox. See [dsh-vm](https://github.com/stansz/dsh-vm#why-libkrun-not-firecracker)
for why libkrun, and for the `no-ipv6` wrapper that works around a libkrun TSI kernel bug.

## Requirements

- Linux with KVM (`/dev/kvm`), rootless Podman, and `crun-krun` (Fedora: `sudo dnf install crun-krun`)
- `curl` and `jq` on the host
- An OpenRouter API key

## Install

```bash
git clone https://github.com/stansz/pi-vm ~/code/pi-vm
cd ~/code/pi-vm
bin/pi-vm build                                    # ~2.5 GB image, a few minutes
ln -sf "$PWD/bin/pi-vm" ~/.local/bin/pi-vm
pi-vm set-key                                      # saves the key to ~/.bashrc.d/openrouter.sh
mkdir -p ~/.claude/skills && cp -r skills/pi-handoff ~/.claude/skills/
```

`set-key` writes `export OPENROUTER_API_KEY=...` to `~/.bashrc.d/openrouter.sh` (mode 600), which
Fedora's default `~/.bashrc` sources. Elsewhere, source that file from your shell's rc file. Start
Claude Code from a new shell so it has the key.

Then in Claude Code: "hand it off to pi".

## Commands

```
pi-vm run [--model ID] [--thinking LEVEL] "<prompt>"   run a handoff; prints the run dir
pi-vm apply <run-dir>   copy the run's changes into the repo as uncommitted changes
pi-vm clean <run-dir>   delete a run (or --all)
pi-vm list              list runs
pi-vm log [run-dir]     follow a run's log live (default: the newest run)
pi-vm model [ID]        show the default model, or check an OpenRouter model ID
pi-vm set-key           save OPENROUTER_API_KEY
pi-vm build             (re)build the image
```

## Updating pi

Bump `PI_VERSION` in `image/Containerfile`, or build with
`pi-vm build --build-arg PI_VERSION=x.y.z`.
