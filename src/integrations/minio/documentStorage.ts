import { createReadStream } from "fs";
import type { Readable } from "stream";
import { minio, BUCKET } from "../../infrastructure/minio.js";
import { logWarn } from "../../infrastructure/systemLog.js";

// Đẩy file tạm trên đĩa lên MinIO bằng stream (không nạp cả file vào RAM).
export async function putObjectFromFile(key: string, filePath: string, size: number, contentType: string): Promise<void> {
  await minio.putObject(BUCKET, key, createReadStream(filePath), size, { "Content-Type": contentType });
}

export function getObjectStream(key: string): Promise<Readable> {
  return minio.getObject(BUCKET, key);
}

// Dọn object mồ côi khi ghi DB thất bại sau upload. Không throw - lỗi dọn chỉ log.
export async function removeObjectQuietly(key: string): Promise<void> {
  try {
    await minio.removeObject(BUCKET, key);
  } catch (e) {
    logWarn({ key, err: (e as Error).message }, "minio_remove_orphan_failed");
  }
}
