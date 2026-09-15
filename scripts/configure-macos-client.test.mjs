import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("configure macOS client", () => {
  it("preserves existing confidential application exclusions", () => {
    const directory = mkdtempSync(join(tmpdir(), "violet-configure-"));
    directories.push(directory);
    const path = join(directory, "client.json");
    writeFileSync(
      path,
      JSON.stringify({
        coreURL: "http://old.invalid",
        excludedContextBundleIds: ["com.example.confidential"],
      }),
    );

    execFileSync(process.execPath, ["scripts/configure-macos-client.mjs", "new-host"], {
      cwd: process.cwd(),
      env: { ...process.env, VIOLET_CLIENT_CONFIG: path },
    });

    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      coreURL: "http://127.0.0.1:14310",
      excludedContextBundleIds: ["com.example.confidential"],
      sshTunnel: { host: "new-host" },
    });
  });
});
