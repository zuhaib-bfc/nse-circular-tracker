import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader. Values already present in process.env always win, so the
 * same build works from a .env file locally and from real env vars in a
 * container or systemd unit.
 */
function loadDotEnv(): void {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const candidate of [resolve(process.cwd(), ".env"), resolve(projectRoot, ".env")]) {
    if (!existsSync(candidate)) continue;
    for (const rawLine of readFileSync(candidate, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key in process.env) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return;
  }
}

loadDotEnv();

function str(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env var ${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function list(key: string): string[] {
  return str(key, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  nse: {
    dept: str("NSE_DEPT", "MF"),
    lookbackDays: num("NSE_LOOKBACK_DAYS", 7),
    retryDelayMs: num("NSE_RETRY_DELAY_SECONDS", 5) * 1000,
    maxRetries: num("NSE_MAX_RETRIES", 4),
    userAgent: str(
      "NSE_USER_AGENT",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    ),
  },
  apiDoc: {
    enabled: bool("TRACK_API_DOCS", true),
    pageUrl: str("APIDOC_PAGE_URL", "https://www.nseinvest.com/nsemfdesk/login.htm"),
    // First capture group must be the version. Change this if NSE renames the file.
    linkPattern: str("APIDOC_LINK_PATTERN", "NSEMF_API_Details_V([0-9]+(?:\\.[0-9]+)*)\\.pdf"),
    // Ranged 1-byte GET to confirm the emailed link actually resolves.
    verifyLink: bool("APIDOC_VERIFY_LINK", true),
  },
  dbPath: str("DB_PATH", "./data/circulars.db"),
  cron: {
    schedule: str("CRON_SCHEDULE", "30 8 * * 1-5"),
    timezone: str("CRON_TIMEZONE", "Asia/Kolkata"),
    runOnStart: bool("RUN_ON_START", true),
  },
  mail: {
    host: str("SMTP_HOST", ""),
    port: num("SMTP_PORT", 587),
    secure: bool("SMTP_SECURE", false),
    user: str("SMTP_USER", ""),
    pass: str("SMTP_PASS", ""),
    from: str("MAIL_FROM", str("SMTP_USER", "")),
    to: list("MAIL_TO"),
    cc: list("MAIL_CC"),
    notifyOnRoutine: bool("NOTIFY_ON_ROUTINE", false),
    dryRun: bool("MAIL_DRY_RUN", false),
  },
  classify: {
    criticalThreshold: num("CRITICAL_THRESHOLD", 6),
    importantThreshold: num("IMPORTANT_THRESHOLD", 3),
    llmBandMin: num("LLM_BAND_MIN", 0),
    llmBandMax: num("LLM_BAND_MAX", 2),
    // GOOGLE_API_KEY is the name the Google SDK itself looks for, so accept both.
    geminiApiKey: str("GEMINI_API_KEY", str("GOOGLE_API_KEY", "")),
    model: str("GEMINI_MODEL", "gemini-3.6-flash"),
    // MINIMAL | LOW | MEDIUM | HIGH, or OFF to omit thinking controls entirely.
    thinkingLevel: str("GEMINI_THINKING_LEVEL", "LOW").toUpperCase(),
  },
  logLevel: str("LOG_LEVEL", "info"),
};

/** Throws if the config can't support sending mail. Called before a real send. */
export function assertMailConfigured(): void {
  const missing: string[] = [];
  if (!config.mail.host) missing.push("SMTP_HOST");
  if (!config.mail.user) missing.push("SMTP_USER");
  if (!config.mail.pass) missing.push("SMTP_PASS");
  if (config.mail.to.length === 0) missing.push("MAIL_TO");
  if (missing.length > 0) {
    throw new Error(
      `Email is not configured. Set ${missing.join(", ")} in .env, or set MAIL_DRY_RUN=true to skip sending.`,
    );
  }
}
