import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Devbox backup script", () => {
  it("does not publish a backup when pg_dump fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "violet-backup-script-"));
    directories.push(directory);
    const bin = join(directory, "bin");
    const data = join(directory, "data");
    const docker = join(bin, "docker");
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "info" ]]; then exit 0; fi
case " $* " in
  *" exec -T postgres pg_dump "*)
    printf 'partial dump'
    exit 7
    ;;
  *" run --rm --no-deps -T backup "*)
    cat >/dev/null
    mkdir -p "$VIOLET_DATA_DIR/backups"
    touch "$VIOLET_DATA_DIR/backups/synthetic.vltbk"
    printf '{"localPath":"/var/lib/violet/backups/synthetic.vltbk"}\\n'
    ;;
  *" backup-upload upload-existing "*)
    touch "$VIOLET_DATA_DIR/uploaded"
    ;;
esac
`,
      { mode: 0o700 },
    );
    chmodSync(docker, 0o700);

    const result = spawnSync("bash", ["scripts/backup-devbox.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        VIOLET_BACKUP_UPLOAD: "true",
        VIOLET_DATA_DIR: data,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pg_dump=7");
    expect(existsSync(join(data, "uploaded"))).toBe(false);
    expect(
      existsSync(join(data, "backups"))
        ? readdirSync(join(data, "backups")).filter((name) => name.endsWith(".vltbk"))
        : [],
    ).toEqual([]);
  });
});
