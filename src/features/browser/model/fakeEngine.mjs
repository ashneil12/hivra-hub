// A stand-in engine for the browser plugin's tests. It records what it was asked and answers
// with a password, a cookie header and a sentence that only mentions a password.
import { appendFileSync } from "node:fs";

const log = process.env.HIVRA_FAKE_LOG;

function write(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function note(message) {
  if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buf.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buf = buf.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buf.length < start + length) return;
    const message = JSON.parse(buf.subarray(start, start + length).toString("utf8"));
    buf = buf.subarray(start + length);
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
