/**
 * `vp run tail`: follows the deployed router and prints one line per request, then any error it
 * logged. Wrangler's raw tail is one pretty-printed JSON event per request, which hides the
 * `ingress crashed` line that says what actually went wrong.
 */
import { spawn } from "node:child_process";

type Log = { level: string; message: unknown[] };
type Event = {
  outcome: string;
  event?: { request?: { method: string; url: string }; response?: { status: number } };
  logs: Log[];
  exceptions: { name: string; message: string }[];
};

function errorsOf(event: Event): string[] {
  const errors = new Set<string>();
  for (const log of event.logs) {
    for (const item of log.message) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as { error?: string; level?: string; message?: string; annotations?: { defect?: string } };
      if (typeof entry.error === "string") errors.add(entry.error.split("\n    at ")[0] ?? entry.error);
      if (entry.level === "ERROR") errors.add(`${entry.message}: ${entry.annotations?.defect ?? ""}`);
    }
  }
  for (const exception of event.exceptions) errors.add(`${exception.name}: ${exception.message}`);
  return [...errors];
}

function print(event: Event): void {
  const request = event.event?.request;
  const status = event.event?.response?.status ?? event.outcome;
  console.log(request ? `${request.method} ${request.url} -> ${status}` : `(${event.outcome})`);
  for (const error of errorsOf(event)) console.log(`  ! ${error}`);
}

const tail = spawn("vpx", ["wrangler", "tail", "applets-router", "--format", "json"], { stdio: ["ignore", "pipe", "inherit"] });
let buffer = "";
tail.stdout.setEncoding("utf8");
tail.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  let end = buffer.indexOf("\n}\n");
  while (end !== -1) {
    print(JSON.parse(buffer.slice(0, end + 2)) as Event);
    buffer = buffer.slice(end + 3);
    end = buffer.indexOf("\n}\n");
  }
});
tail.on("exit", (code) => process.exit(code ?? 0));
