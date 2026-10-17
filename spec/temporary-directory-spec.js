const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const removeTemporaryDirectory = require("./helpers/temporary-directory");

describe("Reference fixture retirement", () => {
  let directory;

  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "reference-cleanup-"),
    );
    fs.writeFileSync(path.join(directory, "source.txt"), "symbol\n");
  });

  afterEach(async () => {
    if (fs.existsSync(directory)) await removeTemporaryDirectory(directory);
  });

  it("retires a real native observation before removing its fixture", async () => {
    const handle = lumine.fileWatchClient.watchDirectory(directory);
    try {
      await handle.ready;
      handle.dispose();
      await removeTemporaryDirectory(directory);
      await handle.closed;
      expect(fs.existsSync(directory)).toBe(false);
      const diagnostics = await lumine.fileWatchClient.diagnostics();
      expect(diagnostics.subscriptions.some((watch) => watch.path === directory)).toBe(false);
    } finally {
      handle.dispose();
      await handle.closed;
    }
  });

  it("refuses to remove the shared temporary root", async () => {
    await expectAsync(removeTemporaryDirectory(os.tmpdir())).toBeRejectedWithError(
      "Reference fixture cleanup escaped its private temporary root",
    );
    expect(fs.existsSync(directory)).toBe(true);
  });

  if (process.platform === "win32") {
    it("waits for an actual exclusive Windows file handle to retire", async () => {
      const lock = holdWindowsFile(path.join(directory, "source.txt"));
      let pending;
      try {
        await lock.ready;
        let settled = false;
        pending = removeTemporaryDirectory(directory).then(
          () => {
            settled = true;
            return null;
          },
          (error) => {
            settled = true;
            return error;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(false);
        expect(fs.existsSync(directory)).toBe(true);
      } finally {
        await lock.release();
      }
      expect(await pending).toBeNull();
      expect(fs.existsSync(directory)).toBe(false);
    }, 15000);
  }
});

function holdWindowsFile(file) {
  const script = `
    $stream = [IO.File]::Open($env:LUMINE_REFERENCE_LOCK_FILE, 'Open', 'Read', 'None')
    try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null }
    finally { $stream.Dispose() }
  `;
  const child = spawn(
    path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      env: { ...process.env, LUMINE_REFERENCE_LOCK_FILE: file },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  const ready = new Promise((resolve, reject) => {
    let output = "",
      errors = "";
    const guard = setTimeout(() => {
      child.kill();
      reject(new Error("The exclusive Windows fixture handle did not become ready"));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(guard);
      reject(new Error(`The fixture handle process exited ${code}: ${errors}`));
    });
    child.stderr.on("data", (data) => (errors += data));
    child.stdout.on("data", (data) => {
      output += data;
      if (output.includes("LOCKED")) {
        clearTimeout(guard);
        resolve();
      }
    });
  });
  return {
    ready,
    async release() {
      child.stdin.end("release\n");
      await closed;
    },
  };
}
