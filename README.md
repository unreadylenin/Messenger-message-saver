# Messenger Message Saver

A Chrome extension for **facebook.com** and **messenger.com** that keeps a private copy of your Messenger chats, so messages stay readable after the sender **unsends** or **deletes** them, lets you turn on **Unseen mode**, and **downloads photos, videos and reels**.

Everything stays on your computer. The extension has no server and sends nothing anywhere.

## ✨ What it does

| Feature | What you see |
|---|---|
| 💾 **Saves messages** | Messages are saved as they arrive or appear on screen: text, photos, stickers, voice-message and link notes, who sent them and when. |
| 🗑️ **Unsent / deleted messages** | Under Messenger's *"… unsent a message"* (or *"deleted a message"*) the saved original appears in a red box, with its photo if there was one. |
| 🔔 **Unsend alerts** | A desktop notification tells you who unsent what. |
| ✏️ **Edited messages** | Earlier versions are kept and shown under the edited message. |
| 👁️ **Unseen mode** | People don't see **"Seen"** when you read their messages. |
| ⌨️ **Hide "typing…"** | People don't see you typing (normal, non-encrypted chats). |
| ⬇️ **Download photos, videos, reels** | Point at a photo, video or reel and press the **⬇** button on it, or right-click → *Download this photo or video*. Videos in HD with sound when Facebook offers it; photos at the largest size the page has. Files go to *Downloads › Facebook*. |
| 📚 **Saved Messages page** | Browse every chat, filter *Unsent / Edited / Photos*, search everything, see Messenger notification copies. |
| 📦 **Backup** | Download a backup (with or without photos), a readable web page, or a spreadsheet (CSV). Restore a backup any time. |
| ⚙️ **Options** | Every feature has its own on/off switch; you can auto-delete old messages after N days. |

## 🧩 Install (about 2 minutes, Windows)

Chrome only installs extensions directly from the Chrome Web Store. For everything else it uses **"Load unpacked"**, which is what these steps do.

1. **Download** `dist/messenger-message-saver-v1.1.0.zip` from this repository (open the file on GitHub → **Download raw file**).
2. **Unzip it** into a folder you will keep, for example `Documents\MessengerMessageSaver`. Chrome loads the extension from this folder every time, so don't delete or move it.

   Or do steps 2 in PowerShell — this unzips the downloaded file into `Documents\MessengerMessageSaver`:

   ```powershell
   Expand-Archive -Path "$env:USERPROFILE\Downloads\messenger-message-saver-v1.1.0.zip" -DestinationPath "$env:USERPROFILE\Documents\MessengerMessageSaver" -Force
   ```

3. In Chrome, type `chrome://extensions` in the address bar and press **Enter**.
4. Turn on **Developer mode** (switch at the top right).
5. Click **Load unpacked** and choose the `MessengerMessageSaver` folder (the one that contains `manifest.json`).
6. Click the puzzle-piece icon 🧩 in the toolbar and **pin** *Messenger Message Saver*.
7. **Reload** any Facebook or Messenger tab that was already open.

Microsoft Edge works the same way: `edge://extensions` → **Developer mode** → **Load unpacked**.

> Chrome may sometimes show a notice about extensions in developer mode. That is normal for extensions not installed from the Web Store; choose to keep the extension.

### Updating
Unzip the new version over the same folder, then press the **↻ reload** arrow on the extension's card in `chrome://extensions`, and reload open Facebook tabs. Version 1.1.0 asks for two more permissions (downloads and the right-click menu); with *Load unpacked* Chrome grants them on reload.

### Uninstalling
Click **Remove** on the extension's card. This also deletes everything it saved (download a backup first if you want to keep it).

## 🖱️ Using it

- **Toolbar icon** → quick switches (Save, Unseen, Hide typing, alerts, photos, download buttons), counts, and the latest unsent messages. The red number on the icon counts newly recovered unsent messages.
- **Alt + Shift + U** turns Unseen mode on or off from any tab (change the key at `chrome://extensions/shortcuts`).
- **Delete chat data** (Saved Messages → Chats) removes that chat's messages, photos, unsend/edit history and the Messenger notification copies titled with the chat's name. Photos that another chat also contains are kept.
- **Open saved messages** → the full page with tabs: *Unsent & deleted*, *Chats*, *Edited*, *Notifications*, *Settings*, *Help*.
- In a chat, recovered messages appear right under Messenger's *"unsent a message"* line. Only you can see these boxes.
- **Downloading:** move the pointer onto a photo, video or reel; a **⬇ Photo / ⬇ Video / ⬇ Reel** button appears at its top-right corner. Settings → *Downloads* chooses HD or SD and whether Chrome asks where to save. Download only what you have the right to keep.

## ⚠️ Limits (read this once)

- **A message can only be recovered if it reached this browser before it was unsent.** Keep facebook.com or messenger.com open in a tab (a chat pop-up or the Messages page). Messages unsent while Facebook was closed on this computer cannot be recovered.
- **End-to-end encrypted chats** (most one-to-one chats now) cannot be read from Messenger's network data, because it is encrypted. For these chats the extension saves what is **shown on screen** and copies of **Messenger notifications**. So the chat (pop-up or page) must have been open, or a notification must have appeared, before the unsend.
- **Unseen in encrypted chats** uses *Strong mode*: Messenger is told the window is not focused, so it does not report "Seen". It works **only on facebook.com/messages and messenger.com** — read encrypted chats there, not in the small chat pop-ups on the news feed, where an encrypted chat can still send "Seen". (Facebook's whole site shares one "is the user here" signal; faking it everywhere stopped the news feed, Watch and Reels from loading, which version 1.0.0 did.) Side effect on Messenger pages: Messenger may play its message sound or show a notification while you are reading. An extra option (off by default) also reports the tab as hidden; use it only if Strong mode alone is not enough, because with several Facebook tabs open, encrypted chats can stop loading until you reload the tab. Replying to a chat always marks it as seen — that is how Messenger works.
- **Unseen in normal chats** holds "Seen" back by sending Messenger's own last-known read position instead of the new one. If that position is not known yet (for example in a tab that was open before you installed or updated the extension), "Seen" is left alone rather than risk marking the chat unread, and the toolbar popup asks you to reload that tab.
- **Check Unseen once with a friend** before relying on it: ask them to message you, open the chat, and ask whether they see "Seen". Facebook can change how "Seen" is sent at any time.
- **"Typing…"** can only be hidden in normal (non-encrypted) chats.
- **Downloads:** Facebook plays videos through a stream that cannot be saved directly, so the extension uses the ready-made MP4 file Facebook lists for each video. If Facebook lists only separate picture and sound tracks, both are saved (`…-picture-only.mp4` and `…-sound-only.m4a`); VLC plays them, or a video editor joins them. Private videos you cannot open yourself cannot be downloaded.
- Facebook changes its website often. If something stops working, open **Settings → Diagnostics** on the Saved Messages page.

## 🔒 Privacy

- Data is stored only in Chrome's storage for this extension on your computer (IndexedDB).
- No analytics, no servers, no remote code. The only network requests the extension makes are to Facebook itself: photos from Facebook's image servers (`fbcdn.net`) so they survive an unsend, and — only when you press a download button — the file you asked for (and, if needed, that video's own Facebook page to find its file).
- Permissions: `storage` + `unlimitedStorage` (saving), `notifications` (unsend alerts), `alarms` (auto-delete old messages), `downloads` + `contextMenus` (the downloader and its right-click entry), and access to `facebook.com`, `messenger.com`, `fbcdn.net`. The downloader accepts only files on Facebook's own servers.
- Please respect other people's privacy: keep what you save for yourself.

## 🛠️ How it works (for the curious)

| Part | File | Job |
|---|---|---|
| Page hook | `extension/content/main-world.js` | Runs inside the Facebook page before Facebook's own code. Reads Messenger's sync data (the *LightSpeed* format, carried over the `gateway.facebook.com` WebSocket, the older MQTT socket and Messenger GraphQL replies — recognised by their query name, so news-feed traffic is never copied), and rewrites your own outgoing *mark read* (tasks 21 and 49) and *typing* requests when Unseen is on. Read markers are only ever rewound to what the server already has — never dropped (that could block sending) and never lowered further (that would mark the chat unread). Strong mode follows Facebook's in-page navigation and hands the real focus back when you leave Messenger. For downloads it reads (never changes) React's data on the photo or video you point at: `videoDeliveryLegacyFields` (`browser_native_hd_url` / `_sd_url`), `progressive_urls`, `hdSrc` / `sdSrc`, DASH manifests as a last resort, and for photos the largest copy with the same file name. |
| Content script | `extension/content/content.js` | Reads messages shown on screen (`[role="log"]` → `[data-scope="messages_table"]` rows, which carry a stable `data-message-id`), notices when a row turns into *"unsent a message"*, and shows the saved original under it. Shows the ⬇ button (one element outside Facebook's own page tree) and saves files of encrypted chats that exist only inside the tab. |
| Background worker | `extension/background/service-worker.js` | Stores everything in IndexedDB, matches placeholders to originals (exact message id first, then same sender + same neighbouring messages), downloads photos, shows alerts. |
| Pages | `extension/popup/`, `extension/dashboard/` | Toolbar popup and the Saved Messages page. |

## 🧪 Development

```bash
npm test          # unit tests + end-to-end test in headless Chromium (needs Playwright)
npm run package   # builds dist/messenger-message-saver-v<version>.zip
npm run icons     # re-renders the icons from scripts/icon.svg
```

The end-to-end test loads the real extension into Chromium, serves a test double of the Messenger page on `https://www.facebook.com/` and a fake gateway WebSocket, and checks saving, unsend recovery (live and after reload), edits, photos, Unseen (Seen + typing), Strong mode staying off the news feed (including in-page navigation in and out of Messenger), downloads (four video data layouts, DASH, reels, photos, encrypted-chat photos, the right-click entry), notification copies, the dashboard and the popup.

Video field names follow the open-source [yt-dlp](https://github.com/yt-dlp/yt-dlp) Facebook extractor as of November 2026.

Protocol details (stored-procedure argument positions, gateway framing, task labels) follow the open-source [mautrix-meta](https://github.com/mautrix/meta) Messenger bridge as of November 2026.

