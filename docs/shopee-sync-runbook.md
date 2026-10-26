# Shopee same-day sync: runbook

For the person who runs the sync and the person who answers its alerts. Plan and reasons: `knowledge/tasks/2026-10-26-shopee-same-day-sync-plan.md` (stories SYN-01 to SYN-08). Status: built locally, not deployed; the Seller Centre export itself still needs the SYN-01 live spike. Until that is done, treat every step below that touches a real Mac as unverified.

## What it does, in one paragraph
The Overview shows when Shopee is behind (finished days with no figures). Pressing **Sync** queues a job for the missing, closed days (always yesterday and earlier, never today). A worker on one of your own Macs exports each day from Seller Centre one at a time, plans it through the import API, and applies it when the plan has no flags. A plan with flags ends the job in **review** and you confirm it on the card. The Monday weekly import is unchanged and later refreshes the same days.

## Rules the server enforces (so you do not have to remember them)
- One sync in flight for the whole team, and one queued. Cooldown 10 minutes, 6 syncs per Manila day.
- A sync runs only on a ready Mac owned by the person who pressed Sync, so the person who types the Shopee password is the person who asked.
- Monday 08:30 to 11:00 Manila time: nothing new starts or is claimed (the weekly export uses the same Seller Centre login). A sync already running is allowed to finish.
- A worker can only plan and apply plain sales_overview files for the days of its own running job, only runs that job planned, and never a plan with flags.
- At most 2 Macs per person and 3 per team.

## Adding a Mac
1. Settings, **My sync Macs**, name the Mac, **Add a Mac**. You get a one-time code (valid 15 minutes) and a `docker run` command. The code is shown once.
2. Run the command on that Mac. The web desktop on the Mac is on `http://127.0.0.1:6080` only (loopback), so it is reachable from that Mac and nowhere else on the network.
3. Sign in to Seller Centre as the shop account in that browser. The Mac then shows **Online** and **Signed in**.
The worker image name in the command is a placeholder until an image is published.

## Pressing Sync
Press **Sync N missing days** on the Overview card. Watch the steps: Requested, Exporting from Shopee, (Verify on the Mac), Importing orders, Done.
- **Needs your password:** open the Shopee browser on your Mac and type the Shopee password there. It continues by itself. The password never goes through Coop, and nothing in the dashboard asks for it. If nobody verifies by the end of the day the sync stops cleanly.
- **Needs your review:** the totals differ from what is loaded by more than the sync allows on its own. Read the flags, then **Confirm and apply** (applies only this job's runs, all or none) or leave it and let the Monday import decide.
- **Failed:** days already loaded are kept. **Retry** loads the rest.

## When an alert arrives
Alerts are built (`src/shopee-sync/alerts.ts`) but not yet sent: there is no email mechanism in the dashboard, and the wiring is marked `TODO(SYN-06 wiring)` in that file. Once wired, one email goes out per failed job (and one for a sync stuck waiting for verification for over 2 hours). It carries the job id, the days and a scrubbed reason. It never carries a screenshot, a link, buyer data, a requester address, a password or a code. Screenshots stay on the worker Mac.
1. Open the Overview card. It shows the same status and the same reason.
2. Reason **worker lost**: the Mac went quiet (asleep, offline, Docker stopped). Wake it, check the Mac shows Online in Settings, then Retry.
3. Reason mentions Seller Centre, a date or a gate: the export or file was refused. Nothing partial was loaded for that day. Check the day by hand once, then Retry. If it repeats, the Seller Centre layout may have changed (SYN-01 and SYN-07).
4. If a sync ended by someone pressing Cancel, or by removing the Mac, no alert is sent (a person did it).
5. Never forward a screenshot of Seller Centre. It shows buyer names.

## The 7-day pilot (SYN-06)
Goal: prove the daily numbers agree with the weekly import before anyone relies on them.
1. For 7 days, run the daily sync as usual. Do not change the weekly Monday import.
2. After the Monday import covers those 7 days, read each day's figures twice from the archive: the value the sync loaded (the `import_runs` row the job points to) and the value now current from the weekly file. Placed sales and confirmed sales for each day.
3. Feed each day to `compareDay` and the list to `summarizePilot` (`src/shopee-sync/pilot.ts`).
4. **Pass** = for all 7 days, placed sales within 1% and confirmed sales within 5% of the weekly figure. Fewer than 7 days compared is not a pass. Any day outside the bounds fails the pilot: write the day, both figures and the cause in the task plan's Outcome section.
5. A same-day figure that the weekly import restates by more than the bounds must show as a `review` flag on that Monday import. If it was applied silently, that is a bug to fix before the pilot can pass.
6. On a pass, flip the registry row to done only when the standing Definition of Done is met, with the date.

## Turning a Mac off
Settings, My sync Macs, **Remove**. That ends any sync the Mac was running (failed with "The Mac was removed during the sync"), the Mac's token stops working on its next poll, and the worker stops. Then delete the container and its volume on the Mac to remove the stored session.

## Never
- Never type the Shopee password or a verification code into Coop, an email, a ticket or a chat. It goes only into the Shopee page on the worker Mac.
- Never run it against PROD without the co-worker's OK; the new tables exist on the local database only until applied by hand (`supabase/shopee_sync.sql`).
