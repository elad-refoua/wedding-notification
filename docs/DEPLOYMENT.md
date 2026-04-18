# Deployment Runbook — Google Cloud Run

Current production hosting: **Google Cloud Run** in GCP project `wedding-netanel-amit`.
(Prior host was Render.com — deprecated and deleted on 2026-04-18.)

## Live service

| Item | Value |
|------|-------|
| Public URL | `https://wedding-notification-246665220680.europe-west1.run.app` |
| GCP project | `wedding-netanel-amit` (project number `246665220680`) |
| Region | `europe-west1` (Belgium — closest GCP region to Israel) |
| Service name | `wedding-notification` |
| Max instances | **1** (single-writer constraint for SQLite over GCS FUSE) |
| Min instances | 0 (scales to zero when idle — free tier) |
| Memory / CPU | 512 MiB / 1 vCPU |
| Persistent DB | `gs://wedding-netanel-amit-data/guests.db` mounted at `/data` |
| Firestore DB | `(default)` in `europe-west1` (created for future use, not currently read) |
| Billing account | `019C7F-38C243-06299A` (existing account on `eladrefoua@gmail.com`, already has card on file) |

## Google account isolation

The wedding project is fully isolated from the MENTI infrastructure. Two `gcloud` configurations exist on the developer laptop:

| Configuration | Account | Project |
|---------------|---------|---------|
| `default` | `menti@mentiverse.ai` | `menti-hipaa` |
| `wedding` | `eladrefoua@gmail.com` | `wedding-netanel-amit` |

**Always run wedding commands from the `wedding` configuration:**
```bash
gcloud config configurations activate wedding   # switch to wedding
# …work…
gcloud config configurations activate default   # switch back to menti
```

Commands that mutate cloud state (deploy, set env vars, IAM) MUST be run while the `wedding` configuration is active or with `--project=wedding-netanel-amit` explicitly passed. Never run them against the menti project.

## Secrets

Application secrets live in Google Secret Manager in the `wedding-netanel-amit` project. They are mounted into the Cloud Run container as environment variables of the same name. Current secrets:

```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
TWILIO_WHATSAPP_NUMBER
DASHBOARD_TOKEN
GEMINI_API_KEY
```

The default Compute service account (`246665220680-compute@developer.gserviceaccount.com`) has `roles/secretmanager.secretAccessor` on each secret and `roles/storage.objectAdmin` on the bucket.

**Updating a secret:**
```bash
gcloud config configurations activate wedding
printf "%s" "NEW_VALUE" | gcloud secrets versions add SECRET_NAME --data-file=-
# Then force a new Cloud Run revision so it picks up the new version:
gcloud run services update wedding-notification --region europe-west1
gcloud config configurations activate default
```

## Deploying a new revision

From the project root, on the `master` branch:

```bash
gcloud config configurations activate wedding

gcloud run deploy wedding-notification \
  --source . \
  --region europe-west1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 1 \
  --min-instances 0 \
  --timeout 300 \
  --port 8080 \
  --add-volume=name=data,type=cloud-storage,bucket=wedding-netanel-amit-data \
  --add-volume-mount='volume=data,mount-path=//data' \
  --set-env-vars "DB_PATH=//data/guests.db,DB_JOURNAL_MODE=DELETE,TZ=Asia/Jerusalem,NODE_ENV=production,WEBHOOK_BASE_URL=https://wedding-notification-246665220680.europe-west1.run.app" \
  --update-secrets "TWILIO_ACCOUNT_SID=TWILIO_ACCOUNT_SID:latest,TWILIO_AUTH_TOKEN=TWILIO_AUTH_TOKEN:latest,TWILIO_PHONE_NUMBER=TWILIO_PHONE_NUMBER:latest,TWILIO_WHATSAPP_NUMBER=TWILIO_WHATSAPP_NUMBER:latest,DASHBOARD_TOKEN=DASHBOARD_TOKEN:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest" \
  --quiet

gcloud config configurations activate default
```

**The `//data` double slash is intentional.** It is a Git Bash (MSYS) trick so the `/data` path is not rewritten into a Windows path when passed to `gcloud`. Cloud Run sees `/data`. Do not remove the double slash on Windows.

## Common operations

### Check logs
```bash
gcloud --project=wedding-netanel-amit run services logs read wedding-notification --region=europe-west1 --limit=50
```

### Get the current revision's env vars
```bash
gcloud --project=wedding-netanel-amit run services describe wedding-notification --region=europe-west1 --format="yaml(spec.template.spec.containers[0].env)"
```

### Snapshot the DB (backup)
```bash
gcloud --project=wedding-netanel-amit storage cp gs://wedding-netanel-amit-data/guests.db ./backup-$(date +%Y%m%d-%H%M%S).db
```

### Rollback to a previous revision
```bash
gcloud --project=wedding-netanel-amit run services list-revisions wedding-notification --region=europe-west1
gcloud --project=wedding-netanel-amit run services update-traffic wedding-notification --region=europe-west1 --to-revisions=REVISION_NAME=100
```

## Free-tier budget

This service is expected to stay inside Google Cloud's free tier indefinitely for a 400-guest wedding:

- **Cloud Run** — first 2M requests/month + 360k GB-seconds + 180k vCPU-seconds are free. Expected usage <1%.
- **Cloud Storage** — 5 GB standard storage + 5 GB network egress are free. DB is <1 MB.
- **Secret Manager** — first 6 secret versions + 10k access operations/month are free.
- **Firestore** — 1 GB storage + 50k reads + 20k writes + 20k deletes per day are free (not actively used yet).

**Billing is linked** (required even on free tier), but **no charges are expected**. If usage spikes beyond free tier, GCP sends email alerts before charges are incurred.

## Twilio webhook config

Each Twilio phone number's webhook points at this service's `/webhooks/*` endpoints. As of 2026-04-18, the sole number is:

| Phone | SID | SMS URL |
|-------|-----|---------|
| `+16562554592` | `PNc92a0d1db7450517a9c6f3ff5bf37c84` | `https://wedding-notification-246665220680.europe-west1.run.app/webhooks/sms` |

When adding a new Twilio number, update its SMS and/or WhatsApp webhooks to point here. The server validates the `X-Twilio-Signature` header when `NODE_ENV=production` — do not change `WEBHOOK_BASE_URL` without re-checking the validation path in `src/services/twilio.js`.

## Data persistence model — important

The service runs SQLite, but the `guests.db` file lives in a Cloud Storage bucket mounted into the container via Cloud Run volume mounts (GCS FUSE). This has three hard constraints:

1. **`--max-instances 1`.** Two instances writing to the same SQLite file over GCS FUSE corrupts it. Never raise this limit.
2. **No WAL mode.** WAL uses memory-mapped files, which GCS FUSE does not support. The code sets `journal_mode=DELETE` via the `DB_JOURNAL_MODE` env var in prod. Local dev keeps WAL for speed.
3. **Writes are slower than local disk.** Every commit flushes the DB file to GCS. For a wedding-scale workload (few hundred writes/day peak), this is fine.

If the app outgrows these constraints, migrate to Firestore (already enabled in the project) or Cloud SQL.
