# Reads the run's assistant messages, one {usage, stopReason, errorMessage} per model call (jq -s),
# and prints token/cost totals, the share of input served from the prompt cache, and how the run
# ended.
. as $msgs
| (map(.usage) | {
    input: (map(.input) | add // 0), output: (map(.output) | add // 0),
    cacheRead: (map(.cacheRead) | add // 0),
    cost: (map(.cost.total) | add // 0),
    misses: (.[1:] | map(select(.input > 20000 and .cacheRead < .input / 10)) | length) }) as $u
| ($msgs | last // {}) as $last
| (if ($u.input + $u.cacheRead) > 0 then ($u.cacheRead * 100 / ($u.input + $u.cacheRead) | floor) else 0 end) as $hit
| "\npi-vm: \($msgs | length) model calls; tokens in \($u.input) + cached \($u.cacheRead) (\($hit)% cached), out \($u.output); cost $\($u.cost * 10000 | round / 10000)",
  (if $u.misses > 0 then "pi-vm: \($u.misses) call(s) missed the cache entirely (a provider switch or an expired cache)" else empty end),
  (if ($msgs | length) == 0 then "pi-vm: run failed: the model never answered"
   elif $last.stopReason == "error" or $last.stopReason == "aborted"
   then "pi-vm: run failed: \($last.stopReason): \($last.errorMessage // "")"
   else "pi-vm: run ended normally (\($last.stopReason))" end)
