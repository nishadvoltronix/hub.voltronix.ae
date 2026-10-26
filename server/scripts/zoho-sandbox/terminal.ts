import { SandboxSetupError } from "./profile.js";

/** Callback authorization codes stay out of shell history, argv and output. */
export function hiddenSandboxCallback(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SandboxSetupError("Run zoho:sandbox:setup in your own interactive terminal.");
  process.stdout.write("Paste the FULL new callback URL, then Enter (input hidden): ");
  return new Promise((resolve, reject) => {
    let value = "", finished = false;
    const wasRaw = process.stdin.isRaw;
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      process.stdin.off("data", onData); process.stdin.off("error", onError); process.stdin.off("end", onEnd);
      process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stdout.write("\n");
      if (error) reject(error); else resolve(value.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", ""));
      value = "";
    };
    const onError = () => finish(new SandboxSetupError("Terminal input failed; no grant saved."));
    const onEnd = () => finish(new SandboxSetupError("Terminal input ended; no grant saved."));
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") { finish(new SandboxSetupError("Setup cancelled; no grant saved.")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char === "\u001b" || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127)) value += char;
        if (value.length > 8204) { finish(new SandboxSetupError("Callback is too long; no grant saved.")); return; }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on("data", onData); process.stdin.once("error", onError); process.stdin.once("end", onEnd);
  });
}
