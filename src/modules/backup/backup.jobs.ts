import { registerJob } from "../../jobs/queues.js";
import { runBackup } from "./backup.runner.js";

// Import 1 lần từ src/index.ts để worker biết handler của job 'backup.create'.
registerJob("backup.create", async (data: { runId: string }) => {
  await runBackup(data.runId);
});
