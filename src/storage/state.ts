import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Persists the SQLite file in Cloud Storage across runs.
 *
 * Cloud Run gives every execution a fresh, empty filesystem. Without this, each
 * run would start with an empty database, see every circular in the lookback
 * window as new, and re-email the whole window — every single day.
 *
 * We copy the file down at start and back up at the end rather than mounting the
 * bucket with GCS FUSE: FUSE does not provide the POSIX locking SQLite needs, and
 * Google explicitly advises against putting database files on it. A single daily
 * job execution is a single writer, so a plain download/upload is both simpler
 * and safer.
 *
 * No-op when STATE_BUCKET is unset, so local development is unaffected.
 */

interface Bucket {
  file(name: string): {
    exists(): Promise<[boolean]>;
    createReadStream(): NodeJS.ReadableStream;
    createWriteStream(options?: unknown): NodeJS.WritableStream;
  };
}

let cachedBucket: Bucket | null = null;

async function getBucket(): Promise<Bucket | null> {
  if (!config.state.bucket) return null;
  if (cachedBucket) return cachedBucket;
  // Imported lazily so local runs never pay for loading the GCS SDK.
  const { Storage } = await import("@google-cloud/storage");
  cachedBucket = new Storage().bucket(config.state.bucket) as unknown as Bucket;
  return cachedBucket;
}

async function download(): Promise<void> {
  const bucket = await getBucket();
  if (!bucket) return;

  const localPath = resolve(config.dbPath);
  mkdirSync(dirname(localPath), { recursive: true });

  const remote = bucket.file(config.state.objectName);
  const [exists] = await remote.exists();
  if (!exists) {
    log.info(
      `No existing state at gs://${config.state.bucket}/${config.state.objectName} — starting a fresh database`,
    );
    return;
  }

  await pipeline(remote.createReadStream(), createWriteStream(localPath));
  const size = statSync(localPath).size;
  log.info(
    `Restored state from gs://${config.state.bucket}/${config.state.objectName} (${size} bytes)`,
  );
}

async function upload(): Promise<void> {
  const bucket = await getBucket();
  if (!bucket) return;

  const localPath = resolve(config.dbPath);
  if (!existsSync(localPath)) {
    log.warn(`No database at ${localPath} to persist`);
    return;
  }

  await pipeline(
    createReadStream(localPath),
    bucket.file(config.state.objectName).createWriteStream({
      resumable: false,
      contentType: "application/vnd.sqlite3",
      metadata: { cacheControl: "no-store" },
    }),
  );
  log.info(
    `Persisted state to gs://${config.state.bucket}/${config.state.objectName} (${statSync(localPath).size} bytes)`,
  );
}

/**
 * Proves we can actually write to the bucket before any work happens.
 *
 * This is not paranoia. A missing or misspelled bucket makes `file.exists()`
 * return false rather than throwing, which is indistinguishable from a genuine
 * first run — so without this check the job would start from an empty database,
 * re-email the entire lookback window, and only discover the problem when the
 * upload failed at the very end. Failing here means failing *before* the emails.
 *
 * A write probe rather than `bucket.exists()`: the job's service account has
 * `objectAdmin`, which grants object writes but not `storage.buckets.get`, so a
 * bucket-level check would false-alarm on a correctly configured deployment.
 */
async function preflight(bucket: Bucket): Promise<void> {
  const probe = bucket.file(`${config.state.objectName}.preflight`);
  await pipeline(
    Readable.from([Buffer.from(new Date().toISOString())]),
    probe.createWriteStream({
      resumable: false,
      contentType: "text/plain",
      metadata: { cacheControl: "no-store" },
    }),
  );
}

/**
 * Runs `work` with the remote database restored beforehand and saved afterwards.
 *
 * The save runs in a `finally` on purpose: if the run emails alerts and then
 * fails later, the already-sent state must still be persisted, or the next run
 * would send those same alerts again.
 */
export async function withPersistentState<T>(work: () => Promise<T>): Promise<T> {
  const bucket = await getBucket();
  if (!bucket) return work();

  try {
    await preflight(bucket);
  } catch (error) {
    throw new Error(
      `Cannot write to gs://${config.state.bucket}/. Refusing to run: starting from an ` +
        `empty database would re-send an alert for every circular in the lookback window. ` +
        `Check the bucket name and that the service account has roles/storage.objectAdmin on it. ` +
        `Underlying error: ${String(error)}`,
    );
  }

  await download();
  try {
    return await work();
  } finally {
    try {
      await upload();
    } catch (error) {
      // Losing the upload means the next run re-sends today's alerts, so this
      // must fail the execution rather than exiting 0 with a log line nobody reads.
      log.error(`FAILED to persist state to Cloud Storage: ${String(error)}`);
      log.error("Next run would re-send these alerts. Marking this execution as failed.");
      process.exitCode = 1;
    }
  }
}
