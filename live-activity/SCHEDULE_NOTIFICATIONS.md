# Schedule result notifications

`live-activity` also supports an explicit, per-schedule phone notification preference. This is separate from ordinary agent attention notifications: scheduled agents disable `notifyOnFinish`, may be archived immediately, and some failures occur before an agent exists.

Install the updated plugin **on the schedule's execution host**. Configure either Bark (no Apple developer credentials required) or APNs. For APNs, select the execution host as the iPhone's push host, configure a key for the phone's signing environment, allow notifications, and register an alert token. The schedule editor enables its switch only when that host has a configured destination. Existing schedules default to off. Ordinary cross-host Live Activity aggregation is unchanged; this monitor covers only local schedules.

## Bark

In the native app's Bark notification settings (also reachable from the schedule editor), paste the HTTPS push URL from the App Store Bark app. The plugin accepts root-hosted URLs of the form `https://server/<device-key>` and test URLs with sample title/body segments. Sample paths and query parameters are not sent. Save, send a test notification, then enable result notifications for the task. The request is sent immediately only when the user chooses the test action; saving alone does not push a test.

- `bark.status({})`, `bark.configure({pushURL})`, `bark.clear({})` return `{configured, serverURL, notifyOnFinish, lastPush}` without the key.
- `bark.preferences({notifyOnFinish})` enables/disables ordinary conversation completion notifications for this host and returns the same status. This is separate from per-schedule preferences and defaults to off, including for existing configurations. Saving the same URL preserves it; a different destination requires a new opt-in.
- `bark.test({})` sends a clearly labeled connection test and returns `{at, ok, status, reason}`. A successful response is server acceptance, not proof of delivery to the phone.
- The key is stored only in `<PASEO_HOME>/live-activity/bark.json` (0600), separately from public plugin settings. Requests use JSON `POST /push` with `device_key` in the body, a ten-second timeout and no redirects. Raw network/server error messages are never exposed, since they might echo a key.
- Bark receives task names and result previews, plus conversation titles and reply previews when that switch is enabled. Notifications belong to Bark; this does not provide Live Activity updates or native reply/approval actions. A configured Bark destination takes priority over APNs for task results and opted-in conversation completions.
- Payload `url` points to `paseonative://schedule?serverId=…&scheduleId=…`. It opens task history even if the run failed before creating an agent. Payload `id` reuses the monitor's per-run collapse ID (Bark versions supporting notification IDs can replace duplicate deliveries).
- Replacing the destination skips earlier completions; saving the same URL preserves pending deliveries. Removing it restores the existing APNs targets, if any.

### Conversation completions

The completion switch observes fresh `agent_attention_required` events with reason `finished`, using the event's reply snapshot and the existing workspace/session title. The source remains a passive observer (`notifications: false`), preserving native Mac notification delivery. Explicit Bark opt-in applies even when the daemon selects an active Mac or the legacy desktop-presence fallback would suppress APNs. Without the switch, the previous APNs policy is unchanged; permission/error events do not become Bark notifications.

Scheduled-run labels and child-agent labels are excluded. If an agent has left the list, its metadata is fetched before delivery so an auto-archived task cannot produce a duplicate ordinary completion. Only local-host events after the configuration/opt-in time and less than two minutes old are eligible. Snapshots are not replayed, duplicate events in the running plugin are deduplicated, and the Bark ID is stable for the host/session/completion timestamp. A later turn has a different ID. Ordinary completions use the existing immediate, best-effort notification path, not the schedule monitor's durable retry ledger.

The link is `paseonative://agent/<serverId>/<agentId>`, opening the corresponding conversation in the existing native route. No task is run by tapping it.

## Schedule preference and monitoring

RPCs in `shared/contracts.ts`:

- `schedule.notifications.read({scheduleId?})` → `{version:1, enabled, revision, ready}`. Omit the ID to check readiness for a new schedule.
- `schedule.notifications.write({scheduleId, enabled, expectedRevision})` → the same state. Enabling validates that a local `new-agent` schedule exists and a push destination is available. Disabling remains possible if the phone is temporarily unavailable. Stale revisions are rejected.

The monitor reads `<PASEO_HOME>/schedules/<id>.json`, the daemon's persisted schedule/run format. It never edits daemon records or injects unsupported schedule configuration fields. It stores preferences and delivery state atomically in `<PASEO_HOME>/live-activity/schedule-notifications.json` with mode `0600`. No credentials are returned by the new RPCs.

Polling starts when the plugin loads, independently of hooks or foreground app requests. Every 15 seconds it checks enabled tasks for `succeeded`/`failed` runs newer than the opt-in time. Notifications include a bounded result/error preview, use `paseo.schedule-result`, and route via `serverId`/`scheduleId` even when `agentId` is absent. Unlike ordinary chat notifications, explicit task-result subscriptions are not suppressed by desktop presence.

Delivery state is tracked per host/schedule/run/device and survives restarts. Transport/APNs failures retry with exponential backoff (1–30 minutes); successful devices are not retried. Only retained history ending within the last 24 hours is eligible. Re-enabling skips completions while disabled. A deleted task or unreadable history does not generate invented results. Invalid preference files are reported and never silently replaced. A process crash between APNs acceptance and saving the delivery acknowledgement can still repeat a notification; retry requests reuse the run's collapse ID.

The execution host must be running to monitor results. Host downtime or a scheduler that produces no run record cannot be detected by this in-process monitor. APNs outages defer task-result delivery; the daemon preparation patch and the original APNs policy (when Bark completion is off) are unchanged.

Validation: `npm run typecheck` and `npm test`. Tests use temporary schedule homes and fake delivery transports; they do not send real notifications or run user tasks. Cover success, failure before agent creation, archive independence, startup recovery, disabled/history isolation, duplicate polls/restart, per-device retries, readiness, IDs, revisions and malformed files. Bark tests cover key privacy, storage permissions, URL validation, API/HTTP/transport failures, retries and restart, and engine readiness without APNs credentials. Real locked-phone delivery and tap navigation remain separate device checks.
