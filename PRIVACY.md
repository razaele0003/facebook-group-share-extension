# Privacy

Group Share Assistant processes information locally in your Chrome profile. It sends no data to an extension developer, analytics provider, AI service, or server. Posting uses Facebook’s existing signed-in session and native interface only after you review a batch and click Start sharing.

## Stored locally

- The chosen post URL and an available visible text excerpt/title.
- The active composer identity’s displayed name and avatar URL pathname fingerprint.
- Available group names, privacy labels, IDs/URLs, and per-identity favorites.
- The reviewed caption, selected destinations, queue state, timestamps, working-tab ID, and per-post duplicate ledger.

Data is stored in `chrome.storage.local`; a browser-session marker is stored in `chrome.storage.session`. It is not synced by this extension. Uninstalling the extension removes its extension storage. No passwords, cookies, access tokens, browser history, or other sites’ content are collected.

## Permissions

| Permission | Purpose |
|---|---|
| `sidePanel` | Display the extension panel. |
| `activeTab` | Read the individual Facebook post URL after you activate the extension. |
| `scripting` | Install the local DOM adapter in the dedicated Facebook working tab. |
| `storage` | Persist favorites, reviewed batches, progress, and duplicate protection. |
| `alarms` | Schedule the next destination and preserve progress across service-worker suspension. |
| Optional `https://www.facebook.com/*` | Discover eligible groups and prepare/submit reviewed native shares on Facebook. Requested by Find groups. |

The extension does not request access to all websites or the browser’s cookies, downloads, history, or debugger. Its extension-page policy prohibits network connections and remote executable scripts.
