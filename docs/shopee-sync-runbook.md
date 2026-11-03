# Shopee same-day sync: runbook

For the person who runs the sync and the person who answers its alerts. Plan and reasons: `knowledge/tasks/2026-10-26-shopee-same-day-sync-plan.md` (stories SYN-01 to SYN-08). Status: built locally, not deployed; the Seller Centre export itself still needs the SYN-01 live spike. Until that is done, treat every step below that touches the real worker as unverified. There is exactly one worker, the cloud box, and no enrolment or Settings screen (decision 2026-10-29, see `CHANGELOG.md`).

## What it does, in one paragraph
The Overview shows when Shopee is behind (finished days with no figures). Pressing **Sync** queues a job for the missing, closed days (always yesterday and earlier, never today). The cloud worker exports each day from Seller Centre one at a time, plans it through the import API, and applies it when the plan has no flags. A plan with flags ends the job in **review** and you confirm it on the card. The Monday weekly import is unchanged and later refreshes the same days.

## Rules the server enforces (so you do not have to remember them)
- One sync in flight for the whole team, and one queued. Cooldown 10 minutes, 6 syncs per Manila day.
- A sync runs on the one cloud worker, whoever pressed Sync, and only while its last reported Shopee login is Ready.
- Monday 08:30 to 11:00 Manila time: nothing new starts or is claimed (the weekly export uses the same Seller Centre login). A sync already running is allowed to finish.
- A worker can only plan and apply plain sales_overview files for the days of its own running job, only runs that job planned, and never a plan with flags.

## The cloud worker
One on-demand cloud server runs the worker. It sleeps when idle and wakes for a sync, about 1 to 4 minutes. Users never type the Shopee password anywhere. When Shopee asks, an admin types it in the worker's own Chrome through the remote browser link.

**Environment (server-only, Vercel; redeploy after changing):**
- `SHOPEE_SYNC_WORKER_TOKEN`: the one shared secret the worker sends as `Authorization: Bearer <secret>` on claim, progress and the import routes. Unset means those routes answer 503 (fail closed); a wrong or empty one gets 401. The box reads the same value from AWS SSM `/coop/shopee-worker/worker-token`.
- `SHOPEE_SYNC_WAKE_TOKEN`: the bearer the AWS Lambda sends to the wake route. Unset means the wake route answers 401 to everyone. It is a different secret from the worker one, and neither is accepted on the other's routes.
- `SHOPEE_SYNC_REMOTE_URL`: the address of the worker's protected remote browser (https only, behind Cloudflare Access). Shown only to a Coop Admin.
- `SHOPEE_SYNC_REMOTE_HOSTS` (optional): comma-separated hosts `SHOPEE_SYNC_REMOTE_URL` may use. When set, any other host makes the link disappear, so a look-alike page cannot be put where an admin types the password.
- No admin list. "Admin" is the existing Coop Admin role (no company, role `coop_admin`). Only a Coop Admin sees the remote browser address and the alerts.

**Setting it up (admin):**
1. Apply `supabase/shopee_sync.sql` by hand (local Docker first, staging with the owner, PROD with the co-worker's OK). Nothing was applied anywhere before this version, so there is no older table to migrate.
2. Generate one random secret (for example `openssl rand -base64 32`). Put it in Vercel as `SHOPEE_SYNC_WORKER_TOKEN` and in SSM as `/coop/shopee-worker/worker-token`. Generate a different one for `SHOPEE_SYNC_WAKE_TOKEN`.
3. Set `SHOPEE_SYNC_REMOTE_URL` (and optionally `SHOPEE_SYNC_REMOTE_HOSTS`) in Vercel, then redeploy.
4. Start the worker. Its first claim call creates the one heartbeat row. Until then the card says the cloud worker has not connected yet (admins see this pointer, everyone else sees "Sync is not set up yet").

**Rotating a secret** (there is no per-worker revoke, so rotation is the revoke): set the new value in both places, Vercel first and then SSM, redeploy the dashboard, and restart the worker so it reads the new value. In the gap the worker gets 401 and simply retries; no job is lost. Rotate `SHOPEE_SYNC_WORKER_TOKEN` if the box or its SSM parameter is ever exposed, and `SHOPEE_SYNC_WAKE_TOKEN` if the Lambda's copy is.

**The worker's HTTP contract** (all `POST`, JSON, `Authorization: Bearer <SHOPEE_SYNC_WORKER_TOKEN>`):
- `/api/shopee/sync/claim` with `{login?: {state, checkedAt}, remote?: {ready}}`. Answers `{job: {id, days, status} | null, activeJobId?}`. Every call updates the heartbeat. A job is handed out only while the last reported login is `ready`. `sessionState` is no longer read.
- `/api/shopee/sync/progress` with `{jobId, status?, days?, error?, login?, remote?}`. Every call updates the heartbeat. An unknown job is 404 (it used to be 403, "not yours": there is only one worker now). 409 with `stop: true` means the job ended and the worker must stop.
- There is no `/api/shopee/sync/enrol`.

**The wake route:** `POST /api/shopee/sync/wake` with `Authorization: Bearer <SHOPEE_SYNC_WAKE_TOKEN>`. It answers `{wake, jobId?}`: `wake` is true only when a job is queued and the worker was not seen in the last 2 minutes (the one heartbeat row). The Lambda polls it and starts the server when it is true. The response has no email or other personal data.

**What the card shows:** the last known Shopee login with its age (Ready, Needs password, Signed out, or Not checked). Sync is off unless it is Ready; a Ready check older than 24 hours counts as unknown ("Waiting for a fresh login check") until the worker checks again. The server reads Asleep, Waking, Online or Offline.

**When Shopee needs the password (admin flow):**
1. Admins see the banner "Shopee needs your sign-in" on the card (also when nothing is behind). Everyone else sees "Waiting for an admin" or "Shopee needs an admin to sign in. Please ask an admin."
2. Press **Open remote browser** (a new tab, Google sign-in through Cloudflare Access), type the Shopee password in the worker's Chrome, and close the tab. The worker re-checks the login and the sync resumes by itself. Coop never sees the password.
3. A sync waiting for a sign-in expires after 60 minutes (it ends as expired; the Monday import still fills the gap).

**Alerts are not sent yet.** The sender is still a TODO (`TODO(SYN-06 wiring)` in `src/shopee-sync/alerts.ts`; Resend is not wired). The message builders and recipients (the Coop Admins, resolved by the future sender) are a parameter, so until the sender is wired nobody is emailed and the card says "Please ask an admin" instead of claiming anyone was told. Admins have to look at the card.

## Pressing Sync
Press **Sync N missing days** on the Overview card. Watch the steps: Requested, Exporting from Shopee, (Admin signs in), Importing orders, Done.
- **Needs your sign-in (admins) or Waiting for an admin (everyone else):** an admin opens the remote browser and types the Shopee password there. It continues by itself. The password never goes through Coop, and nothing in the dashboard asks for it. If nobody signs in within 60 minutes the sync stops cleanly.
- **Needs your review:** the totals differ from what is loaded by more than the sync allows on its own. Read the flags, then **Confirm and apply** (applies only this job's runs, all or none) or leave it and let the Monday import decide.
- **Failed:** days already loaded are kept. **Retry** loads the rest.

## When an alert arrives
Alerts are built (`src/shopee-sync/alerts.ts`) but not yet sent: there is no email mechanism in the dashboard, and the wiring is marked `TODO(SYN-06 wiring)` in that file. Once wired, one email goes out per failed job (and one for a sync stuck waiting for verification for over 2 hours). It carries the job id, the days and a scrubbed reason. It never carries a screenshot, a link, buyer data, a requester address, a password or a code. Screenshots stay on the worker.
1. Open the Overview card. It shows the same status and the same reason.
2. Reason **worker lost**: the server went quiet (stopped, crashed, lost network). Check the card's server line, start the worker, then Retry.
3. Reason mentions Seller Centre, a date or a gate: the export or file was refused. Nothing partial was loaded for that day. Check the day by hand once, then Retry. If it repeats, the Seller Centre layout may have changed (SYN-01 and SYN-07).
4. If a sync ended by someone pressing Cancel, no alert is sent (a person did it).
5. Never forward a screenshot of Seller Centre. It shows buyer names.

## The 7-day pilot (SYN-06)
Goal: prove the daily numbers agree with the weekly import before anyone relies on them.
1. For 7 days, run the daily sync as usual. Do not change the weekly Monday import.
2. After the Monday import covers those 7 days, read each day's figures twice from the archive: the value the sync loaded (the `import_runs` row the job points to) and the value now current from the weekly file. Placed sales and confirmed sales for each day.
3. Feed each day to `compareDay` and the list to `summarizePilot` (`src/shopee-sync/pilot.ts`).
4. **Pass** = for all 7 days, placed sales within 1% and confirmed sales within 5% of the weekly figure. Fewer than 7 days compared is not a pass. Any day outside the bounds fails the pilot: write the day, both figures and the cause in the task plan's Outcome section.
5. A same-day figure that the weekly import restates by more than the bounds must show as a `review` flag on that Monday import. If it was applied silently, that is a bug to fix before the pilot can pass.
6. On a pass, flip the registry row to done only when the standing Definition of Done is met, with the date.

## Turning the worker off
Stop the server. Jobs stop getting heartbeats, so a running one fails as "worker lost" within 10 minutes and a queued one expires after 30. To cut it off for good, rotate `SHOPEE_SYNC_WORKER_TOKEN` (see above) and remove the SSM parameter.

## Never
- Never type the Shopee password or a verification code into Coop, an email, a ticket or a chat. It goes only into the Shopee page in the worker's own Chrome.
- Never run it against PROD without the co-worker's OK; the new tables exist on the local database only until applied by hand (`supabase/shopee_sync.sql`).
