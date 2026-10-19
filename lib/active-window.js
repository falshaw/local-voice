// Foreground window lookup via PowerShell (get-windows rejected: its native binding
// silently returns undefined when missing). Runs at recording start in parallel with
// speech. The title can hold private text: it stays in memory, never stored or logged.

const { execFile } = require("child_process");
const { parseActiveWindowJson } = require("./modes");

const TIMEOUT_MS = 1500;

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "Add-Type -Namespace NV -Name W -MemberDefinition '" +
    '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' +
    '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);' +
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);' +
    "'",
  "$h=[NV.W]::GetForegroundWindow()",
  "$sb=New-Object System.Text.StringBuilder 512",
  "[void][NV.W]::GetWindowText($h,$sb,512)",
  "$p=0; [void][NV.W]::GetWindowThreadProcessId($h,[ref]$p)",
  "$n=''; try { $n=(Get-Process -Id $p).ProcessName } catch {}",
  "[Console]::Out.Write((ConvertTo-Json -Compress @{process=$n; title=$sb.ToString()}))",
].join("; ");

/** Resolves { process, title } or null (timeout, error, malformed output). Never rejects. */
function getActiveWindow(timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
        { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 },
        (err, stdout) => resolve(err ? null : parseActiveWindowJson(stdout)),
      );
    } catch (_) {
      resolve(null);
    }
  });
}

module.exports = { getActiveWindow, TIMEOUT_MS };
