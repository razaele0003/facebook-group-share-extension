# Group Share Assistant

A local Chrome extension for sharing **one original Facebook post** to groups you explicitly select. Works with the currently active Facebook Page or personal profile. No accounts or groups are built into the extension.

## Install

1. Extract `group-share-assistant-1.0.0.zip` if using the ZIP. Keep the extracted folder in a permanent location.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `group-share-assistant-1.0.0` folder containing `manifest.json`.
4. Pin **Group Share Assistant** from Chrome’s Extensions menu. Click its icon to open the side panel.

If using the development project, the ready-to-load folder is `dist/group-share-assistant-1.0.0`. Chrome 120 or newer is required. No Node.js, Python, server, or API key is needed to use the packaged extension.

## Share a post

1. Sign into Facebook and select the Page or profile you want to use.
2. Open an individual post, photo, video, or reel. Use **Use current post**, or paste its full `https://www.facebook.com/...` link into the panel. Profile and feed links are rejected.
3. Click **Find groups** and allow access to `www.facebook.com` when Chrome asks. The extension opens its own Facebook tab, opens the native Share → Share to a group picker, and reads available groups. It does not publish during discovery.
4. Check the **Sharing as** identity. Search and select groups. The star saves favorites separately for each Page/profile; **Use favorites** selects available favorites for the current identity. Group URLs distinguish identical names.
5. Optionally add one caption for all selected groups.
6. Click **Review batch**. Review the identity, original source link, caption, and full destination list. Click **Start sharing** to authorize those shares.
7. Keep Chrome open. The extension uses the native group composer one destination at a time, preserves the original shared attachment, and waits at least 30 seconds after each confirmed result before preparing the next destination. Chrome can delay alarms while asleep.

**Pause** stops preparation before the next submission. **Resume remaining** retries preparation failures and continues queued destinations. **Stop** ends the batch. An already submitted share cannot be recalled by these buttons. **View Facebook** opens the working tab for inspection.

## Understand the results

| Result | Meaning |
|---|---|
| Queued | No submission has started. |
| Preparing | Opening the native composer; no submission intent yet. |
| Submitting | Intent is saved locally and the Post action may already reach Facebook. |
| Posted | A fresh native Facebook publication confirmation was observed. |
| Pending approval | Facebook confirmed submission for group/admin approval; publication is not yet confirmed. |
| Not submitted | Preparation failed before submission intent; Resume can retry it. |
| Check Facebook | Submission may have occurred, but no reliable confirmation was received. This destination is never automatically retried. |

The local duplicate ledger blocks destinations already posted, pending approval, submitting, or uncertain for the same source and identity. Check uncertain results directly on Facebook. This version deliberately has no “force retry” button.

## Recovery and troubleshooting

- Closing the side panel does not cancel a reviewed running batch. Reopen the icon to see persisted progress.
- After a browser restart, the queue stays paused until **Resume remaining** is clicked. A submission interrupted after intent becomes uncertain; preparation interrupted beforehand can resume.
- If the posting identity changes, stop the batch, select the intended identity in Facebook, and use **Find groups** again. Identity checks compare the composer header’s name and avatar fingerprint, never the author of the attached post.
- A changed avatar can require another discovery/review. Favorites are keyed to the verified identity fingerprint.
- Login challenges, account restrictions, unexpected dialogs, ambiguous controls, and layout changes pause the operation. Complete any account/challenge actions yourself in Facebook, then review before resuming. The extension does not bypass restrictions.
- Groups without a stable ID or group URL are unavailable for selection. Incomplete discovery is not saved. A post without a verifiable native shared attachment will not be submitted.
- Use English Facebook on the normal desktop `www.facebook.com` site. Other languages, mobile Facebook, automatic new-post monitoring, scheduling, caption variations, private Facebook API calls, and Chrome Web Store distribution are outside this version.
- If Chrome revokes the Facebook permission, the queue pauses. Grant it again through **Find groups** after stopping the existing batch.
- Removing the extension clears its local history and duplicate protection. Keep it installed while checking uncertain outcomes.

## Privacy and permissions

Everything stays in this Chrome profile. The extension has no backend, telemetry, remote code, cookies permission, credential collection, or private Facebook API client. See [PRIVACY.md](PRIVACY.md) for stored data and permissions.

## Development

```powershell
npm ci
npm run check
npm test
npm run package
```

Tests use local DOM fixtures, mocked Chrome APIs, and a local headless Chrome panel check. Chrome must be installed for the panel test. They do not send real Facebook posts. Runtime files are dependency-free; npm packages are development-only.

Implementation: `panel.*` handles review and controls; `coordinator.js` manages durable state and scheduling; `core.js` contains queue rules; `adapter.js` handles native Facebook DOM interaction; `background.js` registers Chrome event handlers.

The packaged ZIP and unpacked folder include only runtime assets and documentation. Tests, development dependencies, local screenshots, and unrelated workspace files are excluded.

## Validation scope

Native Share → group selection → final Create post composer was inspected on desktop Facebook on October 27, 2026. The identity header, original photo attachment, and final Post control were checked without pressing Post. Automated fixtures exercise final submission confirmations; live publishing has **not** been tested. Facebook UI changes may require adapter updates.
