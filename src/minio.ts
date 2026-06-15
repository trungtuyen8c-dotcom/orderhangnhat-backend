import { Client } from "minio";

export const BUCKET = process.env.MINIO_BUCKET ?? "orderhn";

export const minio = new Client({
  endPoint: process.env.MINIO_ENDPOINT ?? "minio",
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
  accessKey: process.env.MINIO_ROOT_USER ?? "minioadmin",
  secretKey: process.env.MINIO_ROOT_PASSWORD ?? "minioadmin",
});

export async function ensureBucket(): Promise<void> {
  try {
    if (!(await minio.bucketExists(BUCKET))) await minio.makeBucket(BUCKET);
  } catch (e) {
    console.error("MinIO bucket init failed", e);
  }
}
