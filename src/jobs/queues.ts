import { Queue, Worker, type JobsOptions } from "bullmq";
import { config } from "../app/config.js";
import { logger } from "../infrastructure/logger.js";
import { logError } from "../infrastructure/systemLog.js";

// 1 queue chung cho side effect (sheet sync, backup, notification). Tên job phân biệt handler.
// Mỗi tên phải có registerJob tương ứng (scrape chạy đồng bộ trong request nên không có job).
export const JobNames = [
  "sheet.sync.customer",
  "sheet.sync.accounting",
  "sheet.sync.warehouse",
  "backup.create",
  "notification.send",
] as const;
export type JobName = (typeof JobNames)[number];

type JobHandler = (data: any) => Promise<unknown>;

const QUEUE = "side-effects";
const handlers = new Map<JobName, JobHandler>();
let queue: Queue | null = null;
let worker: Worker | null = null;

const connection = () => ({ url: config.redisUrl, maxRetriesPerRequest: null as null });

const defaultOpts: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function registerJob(name: JobName, handler: JobHandler) {
  handlers.set(name, handler);
}

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE, { connection: connection() });
  return queue;
}

// dedupeKey: gộp các yêu cầu trùng đang chờ (vd sync cùng 1 khách liên tiếp); job đang chạy thì giữ lại yêu cầu cuối.
export async function enqueue(name: JobName, data: Record<string, unknown> = {}, opts: JobsOptions & { dedupeKey?: string } = {}) {
  const { dedupeKey, ...rest } = opts;
  try {
    await getQueue().add(name, data, { ...defaultOpts, ...rest, ...(dedupeKey ? { deduplication: { id: `${name}__${dedupeKey}`, keepLastIfActive: true } } : {}) });
  } catch (e) {
    logError({ job: name, err: (e as Error).message }, "job_enqueue_failed");
  }
}

// force: process worker riêng (src/worker.ts) chạy bất kể WORKERS_ENABLED.
export function startWorkers(opts: { force?: boolean } = {}) {
  if (worker || (!opts.force && !config.workersEnabled)) return;
  worker = new Worker(
    QUEUE,
    async (job) => {
      const h = handlers.get(job.name as JobName);
      if (!h) throw new Error(`No handler for job ${job.name}`);
      return h(job.data);
    },
    { connection: connection(), concurrency: 2 },
  );
  worker.on("completed", (job) => logger.info({ job: job.name, job_id: job.id, attempts: job.attemptsMade }, "job_completed"));
  worker.on("failed", (job, err) =>
    logError({ job: job?.name, job_id: job?.id, attempts: job?.attemptsMade, err: err.message }, "job_failed"),
  );
}

export async function stopWorkers() {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
