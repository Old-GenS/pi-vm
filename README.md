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

## Brief mode

When the work has no checkable definition of done — a song, a design pass, a rewrite — skip the
plan:

```bash
pi-vm brief "Write a 16-bar lofi song in D minor at 88 BPM, save it as src/songs/foo.song"
```

Same VM, same clone, same `apply`. The brief goes straight to pi with no `## Files to touch`, no
Acceptance list and no scope check; it uses its own judgement and writes a short note to
`.handoff/report.md`. You review the diff the same way.

Use `run` when there is something to test. Use `brief` when the only test is your own ear.

## Models

The default is `xiaomi/mimo-v2.6-flash` with thinking `low`. Change it in
`~/.config/pi-vm/config` (see `config.example`), or for one run:

```bash
pi-vm model                                   # show the default and its price
pi-vm model qwen/qwen3-coder                  # check a model exists, and its price
pi-vm run --model qwen/qwen3-coder --thinking medium "<prompt>"
```

Settings are taken in this order: `pi-vm run` flags, then `PI_VM_*` environment variables, then the
config file, then the built-in defaults. So `PI_VM_ROUTING='{}' pi-vm run ...` works even when the
config sets `PI_VM_ROUTING`.

In Claude Code, just say which model: "hand it off to pi with kimi". The skill finds the exact ID.

pi's built-in model list lags behind OpenRouter, so for every run pi-vm writes pi a `models.json`
for the chosen model from OpenRouter's own metadata (context size, max output, prices). Any model
on OpenRouter works, and pi's cost totals are right. The file lives next to the run dir, outside
the clone, so pi can't edit it mid-run.

**Routing and caching.** OpenRouter serves most open models from several upstream providers, and
each keeps its own prompt cache. Left alone, OpenRouter moves a model between providers mid-run,
and every move re-sends the whole history uncached: in a 36-minute test run, three moves were 70%
of the fresh input tokens and doubled the cost. So before each run pi-vm ranks the model's
providers (up now, supports tools and caching, an allowed quantization; then the model maker's own
endpoint, such as Xiaomi's for MiMo, which held its cache across whole runs where a reseller
missed it internally; then the most reliable over the last day, then the cheapest) and sends that fixed order: the first serves every call, and the
next are used only if it fails. The run prints the order, and `run.json` keeps it. By default only
fp16/bf16/fp8 endpoints qualify, skipping fp4/int4 ones that are cheaper but worse at long
agentic runs. Set `PI_VM_ROUTING`, or pass `--routing '<json>'` for one run, to change that; a
value with its own `order` or `only` is used as is. The filter is a preference: when no endpoint
of a model passes it (free and preview endpoints often report their quantization as `unknown`, and
some models are served only in fp4), the run drops the filter for that run and prints each
endpoint's quantization. A model with both kinds of endpoint still uses only the allowed ones.

## Logs and cost

pi runs in JSON-event mode. The events go to `.handoff/events.jsonl` in the run dir (without pi's
token-by-token streaming updates, which would make it gigabytes); a readable log (commands run, files edited, the model's thinking and messages, tool errors) goes to
`.handoff/last-run.log`, which `pi-vm log` follows live. The log ends with the number of model
calls, tokens (fresh, cached and output), the share of input served from the cache, any calls
that missed the cache entirely, and the cost of the run. pi's JSON mode always exits 0,
so pi-vm exits non-zero when the last model call ended in an error.

## What the VM can and cannot reach

| Inside the VM | Not inside the VM |
|---|---|
| A clone of the repo (with `.handoff/`) | Your real checkout and its `.git` |
| `OPENROUTER_API_KEY` | SSH keys, `gh` token, any git remote: **it cannot push** |
| The internet (OpenRouter, npm, web) | Your home directory and the rest of the host |
| This repo's own npm cache and `~/.cache` (podman volumes, one pair per repo) | The host kernel (libkrun gives the VM its own) |
| | Services on this computer: no gateway or host-address mapping (other LAN machines are still reachable) |

The key is the one secret inside, so give it a **credit limit** in OpenRouter's key settings.

**The run dir is the agent's, so the host never runs git or the agent's code in it.** The agent
controls the clone's `.git` (hooks, `core.fsmonitor`, filter and diff drivers that host git would
run) and its scripts. `pi-vm diff` and `pi-vm apply` make the patch with git inside a throwaway
VM with no network, and the host only `git apply`s it to your repo, from the commit it recorded
at clone time. `pi-vm exec` runs a check (say, the plan's tests) in a VM without the API key.
`apply` copies `report.md` and `last-run.log` only when they are regular files, not symlinks the
agent planted. The host writes the log through a descriptor opened before the VM starts.

pi runs as **root** inside the VM, so it can `dnf install` whatever a task needs. Under rootless
Podman that root is your own unprivileged user on the host. Chromium runs with `--no-sandbox`,
since the VM is the sandbox. See [dsh-vm](https://github.com/stansz/dsh-vm#why-libkrun-not-firecracker)
for why libkrun, and for the `no-ipv6` wrapper that works around a libkrun TSI kernel bug.

## Requirements

- Linux with KVM (`/dev/kvm`), rootless Podman, and the libkrun runtime (Fedora:
  `sudo dnf install podman crun-krun`). Without libkrun, `./install.sh --container` runs pi in a
  plain rootless container instead: same flow, but it shares your kernel.
- `git`, `curl` and `jq` on the host
- An OpenRouter API key ([openrouter.ai/keys](https://openrouter.ai/keys)); give it a credit limit
- [Claude Code](https://claude.com/claude-code), for the skill

## Install

```bash
git clone https://github.com/stansz/pi-vm ~/code/pi-vm
cd ~/code/pi-vm
./install.sh
```

The installer checks the prerequisites (and says how to install what is missing), links `pi-vm`
into `~/.local/bin`, writes `~/.config/pi-vm/config` from `config.example`, installs the
`pi-handoff` skill into `~/.claude/skills/`, asks for your OpenRouter key, builds the image
(~2.5 GB, a few minutes) and runs pi inside the VM as a smoke test. Run it again to update; it
keeps your config and key. `./install.sh --uninstall` removes the link, the skill, the image and
the caches.

The key goes to `~/.bashrc.d/openrouter.sh` (mode 600), which Fedora's default `~/.bashrc`
sources; elsewhere, source that file from your shell's rc file. Start Claude Code from a new
shell so it has the key. If Claude Code runs as a service (systemd, launchd), the key must be in
that service's environment too.

Then in Claude Code: "hand it off to pi".

## Commands

```
pi-vm run [--model ID] [--thinking LEVEL] "<prompt>"   run a handoff; prints the run dir
pi-vm diff <run-dir> [--stat]   the run's changes as a patch (made in a VM)
pi-vm exec <run-dir> -- <cmd>   run a check in a VM on the run's files, without the key
pi-vm apply <run-dir>   copy the run's changes into the repo as uncommitted changes
pi-vm clean <run-dir>   delete a run (or --all)
pi-vm list              list runs
pi-vm log [run-dir]     follow a run's log live (default: the newest run)
pi-vm model [ID]        show the default model, or check an OpenRouter model ID
pi-vm set-key           save OPENROUTER_API_KEY
pi-vm update            rebuild with the newest pi, if it is newer than the image's
pi-vm build             (re)build the image
```

## Updating pi

The image pins pi (`PI_VERSION` in `image/Containerfile`), so a pi release can't change how
handoffs behave mid-project. `pi-vm update` checks npm and rebuilds with the newest pi only when it
is newer than the image's; `pi-vm build --build-arg PI_VERSION=x.y.z` picks a version by hand. To
update pi-vm itself: `git pull && ./install.sh`.
