# NSE Circular Tracker

Watches two things on a daily schedule and emails stakeholders when either moves:

1. **Mutual Fund circulars** on NSE India — stored in SQLite, scored for
   operational importance, alerting on downtime, suspensions, cut-off changes and
   mock sessions. Routine NFO launches (which dominate the feed) are recorded but
   never emailed.
2. **The NSE MF Desk API specification** — the versioned PDF behind the
   "API STRUCTURE" menu on [nseinvest.com](https://www.nseinvest.com/nsemfdesk/login.htm).
   When the version number goes up, you get an email with a link to the new
   document.

## How it works

```
cron tick
   │
   ├─ 1. bootstrap an NSE session       cookies from the circulars page (the API
   │                                     403s without them; the homepage 403s too,
   │                                     so the circulars page is the entry point)
   ├─ 2. fetch a rolling window          last NSE_LOOKBACK_DAYS days, so a missed
   │                                     run self-heals on the next one
   ├─ 3. drop what we already have       matched on circular number (NSE/NMF/75630)
   │                                     — happens BEFORE classification, so a
   │                                     re-fetch costs nothing and never re-spends
   │                                     LLM tokens
   ├─ 4. classify the genuinely new      keyword rules first; Gemini only for the
   │                                     ambiguous middle band
   ├─ 5. store                            SQLite, one row per circular
   ├─ 6. email                            one HTML digest of everything critical or
   │                                      important that hasn't been sent yet
   └─ 7. check the API doc version        scrape nseinvest.com, compare against the
                                          last version seen, email if it went up
```

Step 7 is wrapped in its own error guard: if nseinvest.com changes its layout or
goes down, the circular run still completes normally.

**Deploying to GCP?** See [DEPLOYMENT.md](DEPLOYMENT.md) — Cloud Run Job + Cloud
Scheduler, with Cloud Build redeploying on every push to `main`.

## Setup

```bash
npm install
cp .env.example .env      # then edit it
npm run build
```

Minimum you must set in `.env` to get alerts: `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS`, `MAIL_TO`. Everything else has a working default.

For Gmail, `SMTP_PASS` must be an [App Password](https://myaccount.google.com/apppasswords),
not your account password.

Verify mail delivery before relying on it:

```bash
node dist/cli.js test-email
```

## Running it

**As a daemon** (has its own scheduler — nothing else needed):

```bash
npm start
```

**From system cron instead**, if you'd rather not keep a process alive:

```cron
30 8 * * 1-5  cd /path/to/nse-circular-tracker && /usr/bin/node dist/cli.js run >> run.log 2>&1
```

**Seed history** so the first real run doesn't email months of back-catalogue.
Backfill stores and classifies everything but suppresses all alerts:

```bash
node dist/cli.js backfill --days 180
```

## Commands

| Command | What it does |
|---|---|
| `start` | Scheduler daemon on `CRON_SCHEDULE` |
| `run [--days N]` | One fetch → classify → store → email cycle |
| `backfill --days N` | Import history without emailing (default 90) |
| `classify "<subject>"` | Show how the rules score a subject line — use this to tune |
| `list [--limit N]` | Recently stored circulars |
| `stats` | Counts by level, last run time, current API doc version |
| `apidoc check` | Check the API doc version now; alerts if it increased |
| `apidoc check --force` | Re-send the alert for the current version (to review the email) |
| `apidoc history` | Every API doc version recorded, with first-seen timestamps |
| `test-email` | Verify SMTP and send a test message |

Add `MAIL_DRY_RUN=true` to any command to log the email instead of sending it.

## Importance classification

Two stages, because the feed is mostly noise and LLM calls cost money.

**Stage 1 — keyword rules** (`src/classify/rules.ts`). Each rule contributes its
weight at most once, so a downtime notice landing on a non-business day scores
higher than either alone. Negative rules exist because ~70% of MF circulars are
routine NFO launches; without them those drift upward on incidental matches.

| Tag | Weight | Example |
|---|---|---|
| `DOWNTIME` | +6 | "Downtime due to maintenance activity on NSE MF Invest Platform" |
| `SUSPENSION` | +5 | "Temporary Suspension of subscription in …" |
| `CUTOFF_CHANGE` | +5 | cut-off / timing revisions |
| `PENAL` | +5 | penalty, fraud, enforcement |
| `NON_BUSINESS_DAY` | +4 | "Non-Business Day for certain schemes …" |
| `MANDATORY` | +4 | "with immediate effect", "mandatory" |
| `MOCK_DR` | +4 | mock sessions, DR drills |
| `REGULATORY` | +3 | SEBI / AMFI / RBI directives |
| `RELEASE` | +3 | go-live, migration, API or file-format change |
| `SETTLEMENT` | +3 | settlement cycle, pay-in/pay-out |
| `ROUTINE_NFO` | **−3** | "Launch of X Fund NFO on NSE MF Invest Platform" |
| `ROUTINE_ADMIN` | **−2** | name changes, empanelment, sub-option intros |

Score ≥ `CRITICAL_THRESHOLD` (6) → **CRITICAL**; ≥ `IMPORTANT_THRESHOLD` (3) →
**IMPORTANT**; otherwise **ROUTINE**.

**Stage 2 — Gemini fallback.** Only circulars scoring inside
`LLM_BAND_MIN`..`LLM_BAND_MAX` (default 0–2) go to the model. Score 0 means no
keyword matched at all, which in practice is the genuinely uncertain set —
"Merger of certain schemes of …", "Change in minimum amount under SIP". Clearly
negative scores are confidently routine and never reach the model.

Uses `gemini-3.6-flash` (`GEMINI_MODEL`) via `@google/genai`, with
`responseMimeType: "application/json"` plus a `responseSchema`, so the verdict is
always well-formed. `temperature: 0` keeps it reproducible, and
`GEMINI_THINKING_LEVEL` (default `LOW`) controls how much the model deliberates —
set it to `OFF` to omit thinking controls entirely. **If the API call fails or the
response is blocked, the deterministic rule verdict stands** — a classifier
outage can never stop circulars being recorded.

Leave `GEMINI_API_KEY` empty to run on keyword rules alone. Everything still
works; you just lose the judgment call on the ambiguous band.

### Tuning

Test a subject line against the rules without touching the network or database:

```bash
$ node dist/cli.js classify "Downtime due to maintenance activity on NSE MF Invest Platform"
Level:   CRITICAL
Score:   6
Tags:    DOWNTIME
Reasons: Platform downtime or unavailability (+6)
```

If something important is being scored as routine, add a pattern to the relevant
rule in `src/classify/rules.ts` or lower `IMPORTANT_THRESHOLD`. Changing weights
does **not** retroactively reclassify stored circulars — delete
`data/circulars.db` and re-backfill if you want a clean re-score.

## API documentation tracking

The "API STRUCTURE" menu on [NSE MF Desk](https://www.nseinvest.com/nsemfdesk/login.htm)
links a versioned spec PDF, currently:

```
/nsemfdesk/resources/upload/apidetails/NSEMF_API_Details_V1.9.7.pdf
```

The page is plain server-rendered HTML, so this is an ordinary anchor scrape — no
browser automation needed. Every `href` is matched against `APIDOC_LINK_PATTERN`,
whose **first capture group must be the version**:

```
APIDOC_LINK_PATTERN=NSEMF_API_Details_V([0-9]+(?:\.[0-9]+)*)\.pdf
```

The version token is stripped from the filename to form a stable `doc_key`
(`NSEMF_API_Details`), so successive releases are recognised as the same document.

**Versions are compared numerically, segment by segment** — `1.9.10` is correctly
newer than `1.9.7`, which a string comparison would get backwards.

What happens on each outcome:

| Outcome | Behaviour |
|---|---|
| **First ever sighting** | Recorded as a silent baseline — *no email*. Otherwise day one would alert "the API docs changed" when nothing has. Use `apidoc check --force` if you do want that first message. |
| **Version increased** | Recorded and emailed, showing `v1.9.6 → v1.9.7` and a link to the new PDF. |
| **Same version** | Nothing. |
| **Version decreased** | Recorded for the audit trail, logged as a warning, *not* emailed — NSE rolled a document back. |
| **Pattern matched nothing** | Logged as a warning. This usually means NSE renamed the file, which is itself worth investigating — fix `APIDOC_LINK_PATTERN` and re-run. |

Check it by hand at any time:

```bash
$ node dist/cli.js apidoc check
unchanged  NSEMF_API_Details v1.9.7 -> v1.9.7
           https://www.nseinvest.com/nsemfdesk/resources/upload/apidetails/NSEMF_API_Details_V1.9.7.pdf

$ node dist/cli.js apidoc history
NSEMF_API_Details      v1.9.7      alerted  first seen 2026-08-10T10:11:33.574Z
NSEMF_API_Details      v1.9.6      alerted  first seen 2026-08-10T10:11:33.000Z
```

### Two kinds of message

The email changes wording depending on whether there is a prior version, so a
baseline never reads as a false alarm:

| | Subject | Tone |
|---|---|---|
| **Baseline** (no prior version) | `[API DOCS] Now tracking NSEMF API Details — currently v1.9.7` | "Nothing has changed yet — this confirms the watch is live." |
| **Upgrade** | `[API DOCS] NSEMF API Details updated — v1.9.6 → v1.9.7` | "The version number changed — review the document." |

To see either format without waiting for NSE to publish, re-send on demand:

```bash
node dist/cli.js apidoc check --force            # sends to MAIL_TO
MAIL_TO=you@example.com node dist/cli.js apidoc check --force   # just you
MAIL_DRY_RUN=true node dist/cli.js apidoc check --force         # print, don't send
```

`--force` clears the sent-flag for the current version and re-queues it; normal
runs remain deduplicated.

Set `TRACK_API_DOCS=false` to turn the whole feature off.

**Note on the PDF link.** nseinvest.com blocks `HEAD` requests (403) and requires a
`Referer` on `GET`, so `APIDOC_VERIFY_LINK` uses a 1-byte ranged GET rather than
downloading the ~3 MB file. The link in the email opens normally in a browser.

## Deduplication

`circDisplayNo` (e.g. `NSE/NMF/75630`) is the primary key. The dedup check runs
as a single `SELECT … IN (…)` *before* classification, so:

- re-running the same window is free and silent
- the overlapping lookback window is safe — a run that fires twice, or covers days
  an earlier run already saw, inserts nothing and emails nothing
- a missed day is picked up automatically by the next run

Alerts are deduplicated separately: `notified_at` is stamped only after the SMTP
server accepts the message, so a mail failure means the circular is retried in the
next digest rather than silently dropped.

## Data

SQLite at `DB_PATH` (default `./data/circulars.db`, gitignored). On Cloud Run the
filesystem is ephemeral, so setting `STATE_BUCKET` syncs this file to Cloud
Storage around each run — see [DEPLOYMENT.md](DEPLOYMENT.md). Unset locally, where
the file on disk is already durable.

- **`circulars`** — every field NSE returns, plus `importance_level`,
  `importance_score`, `importance_reasons`, `importance_tags`, `classifier`
  (`rules` or `llm`), `first_seen_at`, `notified_at`
- **`api_docs`** — one row per `(document, version)` ever seen, so the table
  doubles as a history of how the API spec has moved, plus `notified_at`
- **`runs`** — one row per cycle with window, counts, and any error, for
  after-the-fact "did it run last Tuesday?" questions

## Things worth knowing

- **Classification reads the subject line only.** NSE's listing API doesn't expose
  the circular body, and the attachments are ZIPs of scanned PDFs. The email says
  as much — treat the level as triage, not a substitute for opening the circular.
- **NSE rate-limits and expires cookies aggressively.** The client retries with
  exponential backoff and a fresh session (`NSE_MAX_RETRIES`, default 4), and
  treats an HTML page served as HTTP 200 as a stale-cookie failure.
- **Other departments work too.** Set `NSE_DEPT` (`MF` is Mutual Fund) to track a
  different one; the scoring rules are MF-operations-specific and would want
  revisiting.
- **Flipping `NOTIFY_ON_ROUTINE=true` later** will email every routine circular
  stored so far in one digest, since none of them were ever marked notified.
