# Reads a whole events.jsonl (jq -Rs) and prints token/cost totals and how the run ended.
[split("\n")[] | fromjson? | select(.type == "message_end" and .message.role == "assistant") | .message]
| . as $msgs
| (map(.usage) | {
    input: (map(.input) | add // 0), output: (map(.output) | add // 0),
    cacheRead: (map(.cacheRead) | add // 0), cacheWrite: (map(.cacheWrite) | add // 0),
    cost: (map(.cost.total) | add // 0) }) as $u
| ($msgs | last // {}) as $last
| "\npi-vm: \($msgs | length) model calls; tokens in \($u.input) + cached \($u.cacheRead), out \($u.output); cost $\($u.cost * 10000 | round / 10000)",
  (if ($msgs | length) == 0 then "pi-vm: run failed: the model never answered"
   elif $last.stopReason == "error" or $last.stopReason == "aborted"
   then "pi-vm: run failed: \($last.stopReason): \($last.errorMessage // "")"
   else "pi-vm: run ended normally (\($last.stopReason))" end)
