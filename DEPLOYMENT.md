# Deploying to Google Cloud Run

Deploys the tracker as a **Cloud Run Job** triggered by **Cloud Scheduler**, with
CI/CD from **Cloud Build** on every push to `main`.

Follow the steps in order. Everything is copy-pasteable once you set the
variables in step 1.

---

## Why a Job and not a Service

The app is a batch task: fetch, classify, email, exit. A Cloud Run **Job** is the right shape for that.

A **Service** would be the wrong choice here. Services are request-driven and
scale to zero; outside a request, CPU is throttled to near zero, so the in-process
`node-cron` schedule would fire late or not at all. Keeping it alive means
`--min-instances=1 --cpu-always-allocated`, i.e. paying 24/7 for a job that runs
for ~5 seconds a day, and any second instance would double-send every email.

The `start` daemon command still exists for running on a VM or locally. On Cloud
Run, use the Job.

## The one thing that will break if you skip it

**Cloud Run's filesystem is ephemeral.** The SQLite database is what stops the
tracker re-emailing circulars it has already sent. If it is lost between runs,
every execution sees the whole `NSE_LOOKBACK_DAYS` window as new and re-emails
all of it — to every address in `MAIL_TO` — every single day.

So the job syncs the database to a Cloud Storage bucket: it downloads the file at start and uploads it at the end (including on failure, so alerts already sent are never re-sent). This is set by `STATE_BUCKET` in step 5 and is **not optional** for a real deployment.

> Cloud Storage FUSE volume mounts are deliberately _not_ used. GCS FUSE does not
> provide the POSIX file locking SQLite requires, and Google advises against
> putting database files on it. A download/upload around a single daily execution
> is both simpler and safe, because there is exactly one writer.

Two guards make a misconfigured bucket safe to get wrong:

- **Write preflight.** Before fetching anything, the job writes a small
  `circulars.db.preflight` object. If the bucket is missing or the service
  account can't write to it, the run aborts **before** any email is sent. Without this, a typo'd bucket name is indistinguishable from a genuine first run and would silently re-email the whole window.
- **Failed upload fails the execution.** If the final upload fails, the process exits non-zero so the execution shows as failed in Cloud Run rather than succeeding quietly with only a log line.

---

## 1. Set your variables

```bash
export PROJECT_ID=prodigy-pro
export REGION=asia-south1                 # Mumbai — closest to NSE
export REPOSITORY=nse-tracker             # Artifact Registry repo name
export JOB_NAME=nse-circular-tracker
export STATE_BUCKET=${PROJECT_ID}-nse-tracker-state
export SA_NAME=nse-tracker
export SA_EMAIL=${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com
export IMAGE=${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/nse-circular-tracker

gcloud config set project $PROJECT_ID
```

## 2. Enable the APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com
```

## 3. Create the Artifact Registry repo and the state bucket

```bash
gcloud artifacts repositories create $REPOSITORY \
  --repository-format=docker \
  --location=$REGION \
  --description="NSE circular tracker images"

# Uniform access + versioning: versioning lets you recover the database if a bad
# run ever corrupts it.
gcloud storage buckets create gs://$STATE_BUCKET \
  --location=$REGION \
  --uniform-bucket-level-access

gcloud storage buckets update gs://$STATE_BUCKET --versioning
```

## 4. Create the service account and store the secrets

The job runs as a dedicated least-privilege service account rather than the
default Compute account.

```bash
gcloud iam service-accounts create $SA_NAME \
  --display-name="NSE circular tracker job"

# Read/write only the state bucket — not project-wide storage access.
gcloud storage buckets add-iam-policy-binding gs://$STATE_BUCKET \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin"
```

Create the two sensitive values as secrets. **Only these two are secret** — every
other setting is non-sensitive and goes in as a plain env var in step 5.

```bash
# Gmail App Password (not your account password)
printf '%s' 'bral rpci ocfd colj' | \
  gcloud secrets create smtp-password --data-file=- --replication-policy=automatic

# Gemini API key from https://aistudio.google.com/apikey
printf '%s' 'YOUR_GEMINI_API_KEY' | \
  gcloud secrets create gemini-api-key --data-file=- --replication-policy=automatic

# Let the job read them
for S in smtp-password gemini-api-key; do
  gcloud secrets add-iam-policy-binding $S \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor"
done
```

> `printf` rather than `echo` avoids appending a trailing newline to the secret
> value, which would otherwise break SMTP auth in a way that is annoying to debug.

To rotate a secret later, add a new version — the job picks it up on its next
execution because step 5 pins the version to `latest`:

> ```bash
> printf '%s' 'new-value' | gcloud secrets versions add smtp-password --data-file=-
> ```

## 5. Build and deploy the job

First build. Build **in Cloud Build**, not locally: Cloud Run requires
`linux/amd64`, and an image built on an Apple Silicon Mac is `linux/arm64` and
will fail to start with an exec-format error.

```bash
gcloud builds submit --tag ${IMAGE}:bootstrap
```

Now prepare the non-sensitive configuration. Use a YAML file rather than
`--set-env-vars`: several values (`MAIL_TO`, `MAIL_FROM`) contain commas and `@`,
which collide with that flag's delimiter syntax and silently mangle the values.

```bash
cp env.production.yaml.example env.production.yaml
```

Edit `env.production.yaml` — at minimum set `STATE_BUCKET`, `SMTP_USER`,
`MAIL_FROM`, `MAIL_TO`, and `MAIL_CC`. It is gitignored, and it must never
contain `SMTP_PASS` or `GEMINI_API_KEY` — those come from Secret Manager.

```bash
gcloud run jobs create $JOB_NAME \
  --image=${IMAGE}:bootstrap \
  --region=$REGION \
  --service-account=$SA_EMAIL \
  --max-retries=1 \
  --task-timeout=10m \
  --memory=512Mi \
  --cpu=1 \
  --env-vars-file=env.production.yaml \
  --set-secrets="SMTP_PASS=smtp-password:latest,GEMINI_API_KEY=gemini-api-key:latest"
```

To change configuration later, edit the YAML and run the same flags with
`gcloud run jobs update`. Note `--env-vars-file` **replaces** the whole
environment, so keep the file as the single source of truth.

**`--max-retries=1`** is deliberate. A retry re-runs the whole task; because state
is uploaded in a `finally`, a retry after a partial run will not re-send alerts,
but keeping retries low limits the blast radius of an unexpected failure mode.

### Seed the database before the first scheduled run

Run once manually so the current circulars and the API doc version are recorded as
the baseline. Without this, the first scheduled run treats the entire lookback
window as new and emails all of it.

```bash
# Backfill history with alerts suppressed, then persist that state.
gcloud run jobs execute $JOB_NAME --region=$REGION --wait \
  --args=backfill --args=--days --args=180
```

Verify the state landed in the bucket:

```bash
gcloud storage ls -l gs://$STATE_BUCKET/circulars.db
```

## 6. Schedule it

```bash
# Let Scheduler invoke the job
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker"

gcloud scheduler jobs create http nse-circular-tracker-daily \
  --location=$REGION \
  --schedule="30 8 * * 1-5" \
  --time-zone="Asia/Kolkata" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
  --http-method=POST \
  --oauth-service-account-email=$SA_EMAIL
```

Weekdays at 08:30 IST. Cloud Scheduler owns the schedule now, so `CRON_SCHEDULE`
in the app config is unused in this deployment shape.

Trigger it once by hand to confirm the wiring:

```bash
gcloud scheduler jobs run nse-circular-tracker-daily --location=$REGION
```

## 7. Wire up automatic deploys on push to main

This connects the GitHub repo so every merge to `main` rebuilds and updates the job.

```bash
# One-time: connect GitHub. This opens a browser to authorise the Cloud Build
# GitHub App against zuhaib-bfc/nse-circular-tracker.
gcloud builds connections create github nse-github \
  --region=$REGION

# Follow the printed link, then link the repository:
gcloud builds repositories create nse-circular-tracker \
  --remote-uri=https://github.com/zuhaib-bfc/nse-circular-tracker.git \
  --connection=nse-github \
  --region=$REGION
```

Grant the Cloud Build service account permission to deploy and to act as the job's
service account:

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export CB_SA=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${CB_SA}" --role="roles/run.developer"

gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --member="serviceAccount:${CB_SA}" --role="roles/iam.serviceAccountUser"
```

Create the trigger:

```bash
gcloud builds triggers create github \
  --name=nse-tracker-main \
  --region=$REGION \
  --repository=projects/${PROJECT_ID}/locations/${REGION}/connections/nse-github/repositories/nse-circular-tracker \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml \
  --substitutions=_REGION=${REGION},_REPOSITORY=${REPOSITORY},_JOB_NAME=${JOB_NAME}
```

From now on, every push or merge to `main`:

1. builds the image, tagged with the commit SHA,
2. pushes it to Artifact Registry,
3. runs `gcloud run jobs update` to point the job at the new image.

The build **does not execute the job** — Cloud Scheduler stays the only thing that
triggers real runs, so a deploy never fires an unexpected email. Deploying a
broken image is caught at the next scheduled run, not at merge time; if you want
merge-time verification, add a `gcloud run jobs execute --wait` step with
`MAIL_DRY_RUN=true`.

Verify the trigger:

```bash
gcloud builds triggers list --region=$REGION
git commit --allow-empty -m "test: trigger cloud build" && git push origin main
gcloud builds list --region=$REGION --limit=3
```

---

## Operating it

```bash
# Manual run
gcloud run jobs execute $JOB_NAME --region=$REGION --wait

# Manual run of a specific command (e.g. only the API doc check)
gcloud run jobs execute $JOB_NAME --region=$REGION --wait \
  --args=apidoc --args=check

# Logs from the last execution
gcloud beta run jobs logs tail $JOB_NAME --region=$REGION

# Recent executions and their status
gcloud run jobs executions list --job=$JOB_NAME --region=$REGION --limit=5
```

Inspect or back up the database locally:

```bash
gcloud storage cp gs://$STATE_BUCKET/circulars.db /tmp/circulars.db
sqlite3 /tmp/circulars.db "SELECT importance_level, COUNT(*) FROM circulars GROUP BY 1;"
```

Recover from a bad run (versioning was enabled in step 3):

```bash
gcloud storage ls -a gs://$STATE_BUCKET/circulars.db
gcloud storage cp gs://$STATE_BUCKET/circulars.db#<GENERATION> gs://$STATE_BUCKET/circulars.db
```

### Pausing alerts

```bash
gcloud scheduler jobs pause nse-circular-tracker-daily --location=$REGION
gcloud scheduler jobs resume nse-circular-tracker-daily --location=$REGION
```

---

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec format error` on start                      | Image built for arm64. Build via `gcloud builds submit` or `docker build --platform linux/amd64`.                                                                |
| `Cannot write to gs://… Refusing to run`          | The preflight guard doing its job: bucket name wrong, or the service account is missing `roles/storage.objectAdmin` on it. No email was sent.                    |
| Every run re-emails the same circulars            | `STATE_BUCKET` unset in `env.production.yaml` (the preflight only runs when it's set). Check each run's logs for `Restored state from gs://…`.                   |
| `FAILED to persist state to Cloud Storage`        | Upload failed after the work completed; the execution is marked failed. Fix bucket permissions before the next scheduled run, or it will re-send today's alerts. |
| SMTP auth fails in Cloud Run but works locally    | A trailing newline in the secret. Recreate with `printf '%s'`, not `echo`.                                                                                       |
| Emails stop, logs show `No API docs … matched`    | NSE renamed the API PDF. Update `APIDOC_LINK_PATTERN`.                                                                                                           |
| Job times out                                     | Raise `--task-timeout`; a large `backfill` takes longer than a daily run.                                                                                        |
| Gemini errors in logs, classification still works | Expected — the classifier falls back to keyword rules. Check the key in Secret Manager.                                                                          |

## Cost

At one 5-second execution per weekday this sits inside the Cloud Run free tier;
realistic spend is a few cents a month for Artifact Registry storage and
negligible Cloud Storage. Gemini is only called for ambiguous circulars (roughly
a handful per day), and only if `GEMINI_API_KEY` is set.

## If this outgrows SQLite

The download/upload pattern is sound for one writer and a small database. Move to
Cloud SQL (Postgres) if you add a second scheduled job that writes, need
concurrent executions, or want to query the history from another service. That is
a change to `src/db.ts` only — the rest of the app does not know what the store is.
