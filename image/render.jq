# Turns pi's JSON event stream (one raw line at a time, jq -R) into a readable log.
# Lines that aren't JSON (stderr) pass through unchanged.
def clip($n): if length > $n then .[0:$n] + " …" else . end;
def text_of: [.content[]? | select(.type == "text") | .text] | join("\n");

(fromjson? // {type: "raw", line: .}) as $e
| if $e.type == "raw" then $e.line
  elif $e.type == "message_end" and $e.message.role == "assistant" then
    ($e.message | text_of) as $t
    | ([$e.message.content[]? | select(.type == "thinking") | .thinking | length] | add // 0) as $think
    | [ (if $think > 0 then "· thinking (\($think) chars)" else empty end),
        (if $t != "" then "\n" + $t + "\n" else empty end),
        (if $e.message.stopReason == "error" or $e.message.stopReason == "aborted"
         then "!! \($e.message.stopReason): \($e.message.errorMessage // "")" else empty end)
      ] | join("\n") | select(. != "")
  elif $e.type == "tool_execution_start" then
    if $e.toolName == "bash" then "$ \($e.args.command // "" | clip(400))"
    elif ($e.args.path? // null) != null then "▸ \($e.toolName) \($e.args.path)"
    else "▸ \($e.toolName) \($e.args | tojson | clip(200))" end
  elif $e.type == "tool_execution_end" and $e.isError then
    "  ✗ \(($e.result | text_of? // ($e.result | tostring)) | clip(800))"
  elif $e.type == "auto_retry_start" then
    "· retry \($e.attempt)/\($e.maxAttempts) in \($e.delayMs)ms: \($e.errorMessage)"
  elif $e.type == "compaction_start" then "· compacting context (\($e.reason))"
  else empty end
