// A stand-in engine for the browser plugin's tests. It records what it was asked and answers
// with a password, a cookie header and a sentence that only mentions a password.
import { appendFileSync } from "node:fs";

const log = process.env.HIVRA_FAKE_LOG;

function write(message) {
  const line = JSON.stringify(message);
  if (line.includes("\n") || line.includes("\r")) return;
  process.stdout.write(`${line}\n`);
}

function note(message) {
  if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const end = buf.indexOf("\n");
    if (end < 0) return;
    const line = buf.slice(0, end).replace(/\r$/, "");
    buf = buf.slice(end + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    note({ method: message.method, name: message.params?.name });
    if (message.method === "tools/list") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "browser_navigate", description: "Open a page" },
            { name: "browser_snapshot", description: "Read the page" },
            { name: "browser_evaluate", description: "Run a script" },
            { name: "browser_run_code", description: "Run code" },
            { name: "browser_click", description: "Click something" },
          ],
        },
      });
    } else if (message.method === "tools/call") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: 'Cookie: session=secret\ntextbox "Password": swordfish\n{"password":"swordfish"}\nlanded; cookie=supersecretvalue; done\nThe password field is on the form.',
            },
            { type: "password", value: "swordfish" },
          ],
          headers: { Cookie: "session=secret", "Content-Type": "text/html" },
        },
      });
    } else if (message.id != null) {
      write({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
