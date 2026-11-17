---
name: pi-handoff
description: Write an execution spec to .handoff/plan.md, run it with pi (the pi.dev coding agent) on an OpenRouter model with full access inside a throwaway microVM on a clone of the repo, verify and review the result, report, and apply the changes to the repo when the user approves. Use when the user says "hand it off to pi", "use pi", "pi-vm", "run it with mimo" or names another OpenRouter model to run a handoff ("hand it off with qwen/kimi/glm/gpt"). For "hand off" or "use dsh/deepseek" with no pi or model named, use the handoff skill (dsh) instead.
allowed-tools: Read, Glob, Grep, Write, Bash(pi-vm:*), Bash(git rev-parse:*), Bash(git status:*), Bash(git diff:*), Bash(git -C:*)
---

Do not implement anything yourself. You plan, the executor implements, you verify.

EXECUTOR: pi-vm run (pi --mode json on an OpenRouter model, in a microVM)

The VM sees only a clone of the repo in a run dir, the OpenRouter key and the network. Inside it
pi runs as root with no sandbox and no approvals: it may `dnf install` system packages, install
npm/pnpm/yarn packages, compile native code (gcc, make), run headless Chromium
(`chromium-browser`), and use the network. It has no SSH keys, no gh token and no git remote,
so it cannot push. Your real repo is untouched until step 6.

pi is a single agent: no subagents, no parallel workstreams. Plans are sequential.

If `pi-vm` is not installed, or podman/krun is unavailable, say so and stop. If
`OPENROUTER_API_KEY` is not set, tell the user to run `pi-vm set-key` in a terminal and restart
Claude Code from a new shell.

## Brief mode (no plan)

When the work has no checkable definition of done — a song, a design pass, a rewrite — do not write
a plan at all. Run:

    pi-vm brief [--model ID] [--thinking LEVEL] "<the brief>"

No `.handoff/plan.md` is needed or read; there is no Files to touch, no Acceptance list and no
scope check. pi works in the clone and writes `.handoff/report.md` itself. Then carry on from
step 4 (verify and review) and step 5 (report).

Use it when the user says "hand it off to pi in brief", "brief mode", or asks for creative work
with no test to satisfy. Use `run` whenever there is something that can be checked.

## Model

- Default: whatever `pi-vm model` prints as the default (set in `~/.config/pi-vm/config`, falling
  back to `xiaomi/mimo-v2.6-flash` with thinking `low`). Use it unless the user names a model.
- If the user names a model ("use kimi", "with qwen3 coder"), find its exact OpenRouter ID and
  confirm it exists with `pi-vm model <id>`; that also shows its price. If the name matches several
  models, ask which one. Pass it as `--model <id>`. Pass `--thinking <level>` only if the user
  asks for one (off, minimal, low, medium, high, xhigh).
- A model with no endpoint that passes the config's quantization filter (all `unknown`, or only
  fp4) runs as is: pi-vm drops the filter for that run and prints "no endpoint of <model> is ...
  allowing any for this run" with each endpoint's quantization. Mention it in the report when the
  endpoint is a known low-precision one (fp4, int4). `--routing '<json>'` (before the prompt)
  overrides the routing for a run; use the same `--routing` on every rerun.
- A rerun of the same plan uses the same model and thinking level as the run before, unless the
  user asks to switch. Switching throws away the prompt cache and the comparison.

## Cache discipline

The provider caches the prompt prefix: pi's system prompt, the fixed prompt in step 3, then
`.handoff/plan.md` as the executor reads it, turn after turn. Cached input costs a small fraction
of uncached input. If one byte near the top changes, everything after it is uncached for the
rest of the run, so a small "improvement" to the plan can cost far more than it saves. These rules
keep the prefix byte-identical:

- **Never rewrite `.handoff/plan.md` once the executor has started.** That includes typo fixes,
  rewording, reordering, and fixing a wrong Acceptance command. Before the first run (step 2) you
  may edit it freely. After that, add an `## Amendments` section at the end of the file, or append
  to it if it is already there. Each amendment names the section and item it overrides and says
  what is now true. Earlier text stays exactly as it is.
- **Never put anything that changes between runs in the executor prompt:** no timestamp, date, run
  ID, branch name, or per-run note. Use the step 3 command word for word. Anything that differs per
  run goes in `## Amendments`.
- If the plan seems to need a rewrite partway through, don't rewrite it. Append an amendment, or
  stop and tell the user that the task needs a new plan.

## 1. Preflight

- If the request is exploratory or leaves the scope open (e.g. "look into", "what could we add",
  several possible features), stop here. Look into it, give the user the options with a
  recommendation, and wait for them to choose. Do not write the spec until the scope is agreed;
  the spec holds decisions only.
- Run `git rev-parse --show-toplevel`. If it fails, stop: the handoff needs git as its undo button.
  Tell the user to `git init` (or offer to) and stop.
- Work from that top-level directory for every step below.
- Run `git status --porcelain -- . ":(exclude).handoff"`. If anything is listed, stop and ask the
  user to commit or stash first, so the executor's diff is exactly its own work.
- If `.handoff/.gitignore` does not exist, write it with these lines: `report.md`,
  `last-run.log`, `events.jsonl`, `run.json`. If it exists but lacks `events.jsonl` or `run.json`,
  append them.
- Run `pi-vm list`. If an earlier run of this repo is listed, ask the user whether to apply or
  clean it before starting a new one; don't leave old runs piling up.

## 2. Write the spec

Write `.handoff/plan.md` with exactly these sections:

    ## Goal
    ## Files to touch
    ## Steps
    ## Acceptance
    ## Constraints
    ## Out of scope
    ## If blocked

- Decisions only — no reasoning, no alternatives, no hedges. Assume the executor has none of this
  conversation: name exact file paths, function names, commands, and versions. Order the steps so
  each one can be checked before the next.
- **Acceptance** is a list of runnable commands, each with its expected result (e.g. `npm test`
  exits 0; `node greet.js` prints `hello`). No prose-only criteria.
- **Constraints** always includes: do not commit, push, or switch branches. A step may touch a
  file outside **Files to touch** when it has to — the clone lives in a throwaway VM and is
  discarded — but every such file must appear in the report under "outside the plan", one line
  each saying why. Installing dependencies (`npm ci`, `dnf install`) and temporary files outside
  the repo are fine.
- The clone has no `node_modules` or other ignored files. If Acceptance needs them, make
  installing them (e.g. `npm ci`) the first step.
- Browser checks: the VM has `chromium-browser` (headless) and 2 GB of RAM. Ask for one browser at
  a time. If the project already uses Playwright or Puppeteer, use its own setup and scripts
  (`npx playwright install chromium` is fine; browser downloads are cached between runs). For a
  quick one-off check in a project without one, point it at the system Chromium:
  `executablePath: '/usr/lib64/chromium-browser/chromium-browser'`.

Then check the **Acceptance** commands, before the executor spends anything on them. The code does
not exist yet, so this tests the command, not the result:

- Check each command whose flags, paths, or arguments depend on the installed tool (test runners,
  linters, build tools). Skip commands that only run a file the plan creates (`node greet.js`) or
  standard git commands.
- Make a new temporary directory outside the repo with `mktemp -d`. Put the smallest example there
  that the command needs, in the layout the plan uses (e.g. one passing test file in `lib/`), and
  run the command from that directory. This example is the only code you write, and it never goes
  in the repo. Delete the directory afterwards.
- If the command itself fails (unknown flag, tool missing, a path read the wrong way), fix it in
  `.handoff/plan.md` and check it again. If you cannot make it work, stop and tell the user.
- If a command cannot be tried on a small example (a full app build, anything needing a running
  service), leave it as written and name it in your report as unchecked.

## 3. Run the executor

From the top-level directory, run the EXECUTOR with the Bash tool, `run_in_background: true` and
`timeout: 6000000` (100 minutes: pi-vm stops the VM itself at 90, and the Bash tool's default
background limit of 30 minutes would kill a long run early). Add `--model <id>` (and
`--thinking <level>` or `--routing <json>`) before the prompt only when the Model section says to. pi-vm clones the repo
(with `.handoff/`) into a new run dir, prints its path first and the model second, and writes the
readable log to `<run dir>/.handoff/last-run.log` (raw events in `events.jsonl`):

    pi-vm run "Implement .handoff/plan.md exactly as written. Before you finish, write .handoff/report.md listing files changed, commands run and their results, anything you could not do, and the exact next step. If a step is wrong or impossible, stop and report instead of improvising. Do not commit, push, or switch branches."

Right after starting it, read the background command's output once to get the run dir (its first
line; it appears within a few seconds). Tell the user the executor is running in a microVM, which
model it uses, and both ways to watch it live in a terminal (Ctrl+C stops watching, not the run):

    pi-vm log
    tail -f <run dir>/.handoff/last-run.log

Do not poll after that; you will be notified when it exits.

## 4. Verify and review (read-only)

When the run finishes, take the run dir from the first line of the command's output. Every check
below runs in the run dir (`git -C <run dir> ...`, or commands with that working directory), not in
the repo:

- Read `<run dir>/.handoff/report.md`. If it is missing, read the end of
  `<run dir>/.handoff/last-run.log`. The log's last lines give the token and cost totals and how
  the run ended.
- If the output says `timed out after N minutes`, the VM was stopped mid-run: say so first in the
  report, and treat the run dir as partial work. If it says `run failed`, the model or OpenRouter
  returned an error: give the error.
- Run `git status --porcelain` and `git diff --stat` to see what actually changed.
- Run each **Acceptance** command from the plan and compare against its expected result.
- Review the code: read the full `git diff` and every new untracked file (`git diff` does not show
  those). Check it against `.handoff/plan.md` for bugs, missing or half-done steps, changes outside
  **Files to touch**, and anything **Out of scope**. Passing Acceptance does not end the review.
- Before recommending apply, check the run with the repo's own checks, never the executor's copies:
  1. `git -C <run dir> diff --name-only HEAD -- tools/check tools/analysis` — any file listed is a
     flag (the executor edited a check).
  2. `git -C <run dir> checkout HEAD -- tools/check tools/analysis` — puts the checks back exactly
     as they are in the repo (the run dir's HEAD is the repo's HEAD), discarding the executor's
     edits to them. This is the one edit allowed during verification.
  3. In the run dir, run `npm run check:generators` and `npm run check:songs` (drumline-radio).
     Any copy `check:generators` lists that involves a new or changed script is a flag.
  Report every flag to the user in plain words before anything else: what the model did, why it
  breaks the repo's rules, and what you recommend (fix it, or drop the run). Every flag is a stop,
  whatever its size; never call one minor. For example: "Grey Coast's script copies two helpers
  from First Flight's script instead of using lib.mjs, and the model edited the copy check to hide
  it. Recommend: don't apply until it's fixed." Put
  the check's raw output underneath, for reference. Do not apply until the user answers.
- Do not edit any file during verification.

## 5. Report

Report: the model and thinking level, exit status, cost (from the log's last lines), files
changed (from git, not the report) — naming separately any file that was not in **Files to
touch**, with the reason it changed — each Acceptance check with pass/fail, any Acceptance
commands left unchecked before the run, your code review findings (or that you found none),
anything the executor said it could not do, and the exact next step. Where the executor's report
and your verification disagree, say so plainly.

Give the run dir path and ask whether to apply the changes to the repo.

Do not re-plan, patch, or fix failures yourself unless the user asks.

## 6. Apply or clean (only when the user says so)

- Apply: from the repo's top-level directory run `pi-vm apply <run dir>`. It replays the run's
  changes as uncommitted changes (new files untracked) and copies `report.md` and `last-run.log`
  into `.handoff/`. Then run `pi-vm clean <run dir>`.
- Discard: run `pi-vm clean <run dir>`.

The user reviews the diff and commits, including `.handoff/plan.md`. `report.md`, `last-run.log`,
`events.jsonl` and `run.json` stay ignored. Never leave a run dir behind once the user has decided.
