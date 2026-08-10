#!/usr/bin/env node
import { compareVersions } from "./apidoc/scraper.js";
import { checkApiDocs, notifyApiDocChanges } from "./apidoc/tracker.js";
import { classifyByRules } from "./classify/index.js";
import { config } from "./config.js";
import { CircularStore } from "./db.js";
import { startScheduler } from "./index.js";
import { log, setLogLevel } from "./logger.js";
import { NseClient, daysAgo } from "./nse/client.js";
import { sendTestEmail } from "./notify/mailer.js";
import { backfill, runOnce } from "./pipeline.js";
import { withPersistentState } from "./storage/state.js";

setLogLevel(config.logLevel);

const USAGE = `nse-circular-tracker

  start                 Run the scheduler daemon (cron: ${config.cron.schedule} ${config.cron.timezone})
  run [--days N]        Run one fetch/classify/notify cycle now
  backfill --days N     Import history without emailing (default 90)
  classify "<subject>"  Show how the keyword rules score a subject line
  list [--limit N]      Show recently stored circulars
  stats                 Show database counts
  apidoc [check]        Check the NSE MF Desk API doc version now (alerts if newer)
  apidoc history        Show every API doc version recorded so far
  test-email            Verify SMTP settings and send a test message

Configuration lives in .env — copy .env.example to get started.`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function numericFlag(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Commands that read or write the database, and so need remote state synced. */
const STATEFUL_COMMANDS = new Set(["run", "backfill", "apidoc", "list", "stats"]);

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);

  // On Cloud Run the SQLite file lives in Cloud Storage between executions.
  // Locally this is a no-op and the file on disk is used directly.
  if (STATEFUL_COMMANDS.has(command)) {
    return withPersistentState(() => dispatch(command, args));
  }
  return dispatch(command, args);
}

async function dispatch(command: string, args: string[]): Promise<void> {
  switch (command) {
    case "start": {
      startScheduler();
      return; // daemon: never resolves past here
    }

    case "run": {
      const days = numericFlag(args, "days", config.nse.lookbackDays);
      const summary = await runOnce({ from: daysAgo(days) });
      log.info(
        `Done: ${summary.fetched} fetched, ${summary.inserted} new, ${summary.duplicates} duplicates, ${summary.notified} emailed`,
      );
      log.info(
        `Breakdown — critical ${summary.byLevel.CRITICAL}, important ${summary.byLevel.IMPORTANT}, routine ${summary.byLevel.ROUTINE}`,
      );
      log.info(
        `API docs — ${summary.apiDocUpgrades} new version(s), ${summary.apiDocsNotified} emailed`,
      );
      return;
    }

    case "backfill": {
      const days = numericFlag(args, "days", 90);
      log.info(`Backfilling ${days} days (no emails will be sent)`);
      const summary = await backfill(days);
      log.info(`Backfill done: ${summary.fetched} fetched, ${summary.inserted} stored`);
      log.info(
        `Breakdown — critical ${summary.byLevel.CRITICAL}, important ${summary.byLevel.IMPORTANT}, routine ${summary.byLevel.ROUTINE}`,
      );
      return;
    }

    case "classify": {
      const subject = args.join(" ").trim();
      if (!subject) throw new Error('Usage: classify "Downtime of NSE MF Invest platform"');
      const verdict = classifyByRules({
        sub: subject,
        circCategory: "",
        circDisplayNo: "(preview)",
        cirDate: "",
        cirDisplayDate: "",
        circCompany: "",
        circDepartment: "",
        circFileSize: "",
        circFilelink: "",
        circFilename: "",
        circNumber: "",
        fileDept: "",
        fileExt: "",
      });
      console.log(`Level:   ${verdict.level}`);
      console.log(`Score:   ${verdict.score}`);
      console.log(`Tags:    ${verdict.tags.join(", ") || "(none)"}`);
      console.log(`Reasons: ${verdict.reasons.join("; ")}`);
      return;
    }

    case "list": {
      const limit = numericFlag(args, "limit", 20);
      const store = new CircularStore();
      try {
        const rows = store.recent(limit);
        if (rows.length === 0) {
          console.log("No circulars stored yet. Run `nse-circulars run` first.");
          return;
        }
        for (const row of rows) {
          const mark = row.notified_at ? "sent" : "new ";
          console.log(
            `${row.importance_level.padEnd(9)} ${mark}  ${row.circDisplayNo.padEnd(16)} ${row.cirDisplayDate.padEnd(18)} ${row.sub}`,
          );
        }
      } finally {
        store.close();
      }
      return;
    }

    case "stats": {
      const store = new CircularStore();
      try {
        const stats = store.stats();
        console.log(`Total circulars:      ${stats.total}`);
        console.log(`  critical:           ${stats.byLevel["CRITICAL"] ?? 0}`);
        console.log(`  important:          ${stats.byLevel["IMPORTANT"] ?? 0}`);
        console.log(`  routine:            ${stats.byLevel["ROUTINE"] ?? 0}`);
        // Routine circulars stay "never emailed" for good: they are stored for
        // the record but never cross the alert bar unless NOTIFY_ON_ROUTINE=true.
        console.log(`Never emailed:        ${stats.unnotified}`);
        console.log(`Last run finished:    ${stats.lastRun ?? "never"}`);

        const docs = store.apiDocHistory();
        const latestByKey = new Map<string, string>();
        for (const doc of docs) {
          const seen = latestByKey.get(doc.docKey);
          if (!seen || compareVersions(doc.version, seen) > 0) latestByKey.set(doc.docKey, doc.version);
        }
        console.log(
          `\nAPI docs tracked:     ${latestByKey.size === 0 ? "none yet" : ""}`.trimEnd(),
        );
        for (const [key, version] of latestByKey) {
          console.log(`  ${key}: v${version}`);
        }
      } finally {
        store.close();
      }
      return;
    }

    case "apidoc": {
      const store = new CircularStore();
      try {
        const sub = args[0] ?? "check";
        if (sub === "history") {
          const rows = store.apiDocHistory();
          if (rows.length === 0) {
            console.log("No API doc versions recorded yet. Run `nse-circulars apidoc check`.");
            return;
          }
          for (const row of rows) {
            const mark = row.notified_at ? "alerted" : "pending";
            console.log(
              `${row.docKey.padEnd(22)} v${row.version.padEnd(10)} ${mark.padEnd(8)} first seen ${row.first_seen_at}`,
            );
          }
          return;
        }
        // Default: scrape, reconcile, and alert on any version increase.
        const changes = await checkApiDocs(store);
        if (changes.length === 0) {
          console.log("No API documents matched APIDOC_LINK_PATTERN — see the warning above.");
          process.exitCode = 1;
          return;
        }
        // --force re-queues the current version even if it was already recorded
        // or sent, so you can review the email format on demand.
        if (args.includes("--force")) {
          for (const change of changes) {
            store.resetApiDocNotification(change.doc.docKey, change.doc.version);
          }
          log.info(`--force: re-queued ${changes.length} document(s) for emailing`);
        }
        for (const change of changes) {
          const from = change.previousVersion ? `v${change.previousVersion} -> ` : "";
          console.log(
            `${change.kind.padEnd(10)} ${change.doc.docKey} ${from}v${change.doc.version}`,
          );
          console.log(`           ${change.doc.url}`);
        }
        const notified = await notifyApiDocChanges(store, changes);
        if (notified > 0) console.log(`\nEmailed ${notified} API doc update(s).`);
      } finally {
        store.close();
      }
      return;
    }

    case "test-email": {
      await sendTestEmail();
      return;
    }

    case "peek": {
      // Undocumented helper: fetch and score without touching the database.
      const days = numericFlag(args, "days", 7);
      const circulars = await new NseClient().fetchCirculars(daysAgo(days), new Date());
      for (const circular of circulars) {
        const verdict = classifyByRules(circular);
        console.log(
          `${verdict.level.padEnd(9)} ${String(verdict.score).padStart(3)}  ${circular.circDisplayNo.padEnd(16)} ${circular.sub}`,
        );
      }
      console.log(`\n${circulars.length} circulars over the last ${days} day(s)`);
      return;
    }

    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
