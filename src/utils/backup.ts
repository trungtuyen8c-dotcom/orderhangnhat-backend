import { exec as execCb, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { prisma } from "../db.js";
import { minio, BUCKET } from "../minio.js";

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

const REMOTE = "gdrive";
const REMOTE_DIR = "duan-order-backups";
const KEEP = 14;
const STAGE_ROOT = "/tmp/backups";

// rclone đã có remote gdrive chưa (đã dán token chưa)
export async function rcloneConnected(): Promise<boolean> {
  try {
    const { stdout } = await execFile("rclone", ["listremotes"]);
    return stdout.split("\n").map((s) => s.trim()).includes(`${REMOTE}:`);
  } catch {
    return false;
  }
}

// Dán token (JSON từ `rclone authorize "drive"`) -> tạo remote gdrive
export async function setRcloneToken(tokenJson: string): Promise<void> {
  JSON.parse(tokenJson); // validate, lỗi -> throw
  await execFile("rclone", ["config", "create", REMOTE, "drive", "scope", "drive", "token", tokenJson, "--non-interactive"]);
}

export async function disconnectRclone(): Promise<void> {
  try { await execFile("rclone", ["config", "delete", REMOTE]); } catch { /* ignore */ }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await stat(p)).size;
  }
  return total;
}

async function listMinioObjects(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    const stream = minio.listObjects(BUCKET, "", true);
    stream.on("data", (o) => { if (o.name) names.push(o.name); });
    stream.on("end", () => resolve(names));
    stream.on("error", reject);
  });
}

// Chạy 1 backup (async). Cập nhật BackupRun theo tiến trình.
export async function runBackup(runId: string): Promise<void> {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/(\d{8})(\d{6})/, "$1-$2");
  const stage = join(STAGE_ROOT, ts);
  const log: string[] = [];
  const add = (m: string) => { log.push(m); };
  try {
    await prisma.backupRun.update({ where: { id: runId }, data: { status: "running" } });
    await mkdir(stage, { recursive: true });

    // 1) Database
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("Thiếu DATABASE_URL");
    add("dump database...");
    await exec(`pg_dump "${dbUrl}" --clean --if-exists | gzip > "${join(stage, "db.sql.gz")}"`, { maxBuffer: 256 * 1024 * 1024 });

    // 2) File MinIO -> tar
    add("archive MinIO files...");
    const filesDir = join(stage, "files");
    await mkdir(filesDir, { recursive: true });
    const objs = await listMinioObjects();
    for (const name of objs) {
      const dest = join(filesDir, name);
      await mkdir(dirname(dest), { recursive: true });
      await minio.fGetObject(BUCKET, name, dest);
    }
    await execFile("tar", ["-czf", join(stage, "minio.tar.gz"), "-C", filesDir, "."]);
    await rm(filesDir, { recursive: true, force: true });
    add(`MinIO: ${objs.length} file`);

    // 3) Upload Drive
    if (!(await rcloneConnected())) throw new Error("Chưa kết nối Google Drive (chưa dán token)");
    add(`upload -> ${REMOTE}:${REMOTE_DIR}/${ts}`);
    const size = await dirSize(stage);
    await execFile("rclone", ["copy", stage, `${REMOTE}:${REMOTE_DIR}/${ts}`], { maxBuffer: 64 * 1024 * 1024 });

    // 4) Retention: giữ KEEP bản mới nhất
    try {
      const { stdout } = await execFile("rclone", ["lsf", `${REMOTE}:${REMOTE_DIR}`, "--dirs-only"]);
      const dirs = stdout.split("\n").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean).sort();
      for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
        add(`purge old: ${d}`);
        await execFile("rclone", ["purge", `${REMOTE}:${REMOTE_DIR}/${d}`]).catch(() => {});
      }
    } catch { /* ignore retention errors */ }

    await prisma.backupRun.update({
      where: { id: runId },
      data: { status: "success", finishedAt: new Date(), sizeBytes: BigInt(size), remotePath: `${REMOTE_DIR}/${ts}`, logTail: log.join("\n").slice(-4000) },
    });
  } catch (e) {
    await prisma.backupRun.update({
      where: { id: runId },
      data: { status: "failed", finishedAt: new Date(), error: (e as Error).message.slice(0, 500), logTail: log.join("\n").slice(-4000) },
    }).catch(() => {});
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
