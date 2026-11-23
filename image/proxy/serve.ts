/**
 * Standalone entry point for the egress proxy.
 *
 * The proxy itself is vendored unchanged from ogsapps/agent-hive (src/egress.ts, MIT). See
 * ./README.md for why and how to keep the two in sync.
 *
 * Environment:
 *   EGRESS_PORT   port to listen on, on 127.0.0.1 (default 3128)
 *   EGRESS_DEBUG  1 to log refused destinations to stderr
 */
import { startEgressProxy } from "./egress.ts";

const rawPort = process.env.EGRESS_PORT ?? "3128";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`egress: invalid EGRESS_PORT: ${rawPort}`);
  process.exit(2);
}

const debug = process.env.EGRESS_DEBUG === "1";
const proxy = await startEgressProxy({
  port,
  log: debug ? (line: string) => console.error(`egress: ${line}`) : undefined,
});

// startEgressProxy calls server.unref(), which is right when hive embeds it in a long-lived CLI
// but would let this process exit on its own. Hold the event loop open for the container's life.
setInterval(() => undefined, 1 << 30);
console.log(`egress: listening on ${proxy.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void proxy.close().finally(() => process.exit(0));
  });
}
