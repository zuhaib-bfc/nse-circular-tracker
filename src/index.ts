import cron from "node-cron";
import { config } from "./config.js";
import { log } from "./logger.js";
import { runOnce } from "./pipeline.js";
import { withPersistentState } from "./storage/state.js";

/**
 * Long-running daemon. Keeps a single process alive and fires the pipeline on the
 * configured cron schedule. A failing run is logged and swallowed so one bad day
 * (NSE down, network blip) doesn't kill the scheduler.
 */
export function startScheduler(): void {
  if (!cron.validate(config.cron.schedule)) {
    throw new Error(`CRON_SCHEDULE is not a valid cron expression: ${config.cron.schedule}`);
  }

  let running = false;

  const tick = async (trigger: string): Promise<void> => {
    if (running) {
      log.warn(`Skipping ${trigger} run — previous run still in progress`);
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      // Sync remote state around each tick when STATE_BUCKET is configured, so
      // the daemon deployment shape behaves like the job deployment shape.
      const summary = await withPersistentState(() => runOnce());
      log.info(
        `Run complete in ${Math.round((Date.now() - startedAt) / 1000)}s: ` +
          `${summary.fetched} fetched, ${summary.inserted} new ` +
          `(${summary.byLevel.CRITICAL} critical / ${summary.byLevel.IMPORTANT} important / ${summary.byLevel.ROUTINE} routine), ` +
          `${summary.notified} emailed` +
          (summary.apiDocUpgrades > 0 ? `; ${summary.apiDocUpgrades} API doc update(s)` : ""),
      );
    } catch (error) {
      log.error(`Run failed: ${String(error)}`);
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(config.cron.schedule, () => void tick("scheduled"), {
    timezone: config.cron.timezone,
  });

  log.info(
    `Scheduler started — cron "${config.cron.schedule}" (${config.cron.timezone}), dept=${config.nse.dept}, lookback=${config.nse.lookbackDays}d`,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info(`Received ${signal}, stopping scheduler`);
      task.stop();
      process.exit(0);
    });
  }

  if (config.cron.runOnStart) {
    log.info("RUN_ON_START=true — running one cycle now");
    void tick("startup");
  }
}
