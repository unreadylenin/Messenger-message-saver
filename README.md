# Messenger Message Saver

A browser extension for **facebook.com** and **messenger.com** that keeps a private copy of your Messenger chats, so messages stay readable after the sender **unsends** or **deletes** them. It can also turn on **Unseen mode**, **downloads photos, videos and reels**, works in **English or বাংলা (Bangla)**, and can lock the saved messages with a **PIN**.

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
| 🌐 **English / বাংলা** | The whole extension (popup, Saved Messages, the boxes and buttons inside Facebook, alerts) in English or Bangla: **EN \| বাং** in the popup, or Settings → Language. |
| 🔒 **PIN lock** (optional) | Settings → Privacy: other people who use the computer can't open your saved messages, backups or settings without the PIN. |
| 📚 **Saved Messages page** | Browse every chat, filter *Unsent / Edited / Photos*, search everything, see Messenger notification copies. |
| 📦 **Backup** | Download a backup (with or without photos), a readable web page, or a spreadsheet (CSV). Restore a backup any time. |
| ⚙️ **Options** | Every feature has its own on/off switch; you can auto-delete old messages after N days. |

## 🧩 Install (about 2 minutes, any Windows PC)

Chrome installs extensions directly only from the Chrome Web Store. Anything else uses **"Load unpacked"**, and these steps do exactly that. Steps for Edge, Brave and Opera are inside the ZIP.

1. **Get the ZIP:** `dist/MessengerMessageSaver-v1.2.0-share.zip` (on GitHub: open the file → **Download raw file**), or the copy a friend sent you. It contains `HOW-TO-INSTALL.txt` (English + বাংলা) and a folder called `MessengerMessageSaver`.
2. **Extract it:** right-click the ZIP → **Extract All…** → **Extract**.
3. **Put the folder in its permanent place:** press **Windows + R**, type `%USERPROFILE%` and press **Enter**. Then drag the `MessengerMessageSaver` folder into the window that opens (your user folder, for example `C:\Users\YourName`).
   - Don't use Desktop, Documents or Downloads: OneDrive or a clean-up can move or delete it.
   - Never move or rename the folder later. Chrome would treat it as a new extension, and the saved messages would seem to be gone.
4. In Chrome, type `chrome://extensions` in the address bar and press **Enter**.
5. Turn on **Developer mode** (switch at the top right).
6. Click **Load unpacked** and choose the `MessengerMessageSaver` folder (the one that contains `manifest.json`). If Chrome says *"Manifest file is missing"*, you picked the folder around it.
7. Click the puzzle-piece icon 🧩 in the toolbar and **pin** *Messenger Message Saver*.
8. **Reload** any Facebook or Messenger tab that was already open.

> Chrome may show a notice about extensions in developer mode. That is normal for extensions not installed from the Web Store; choose to keep the extension. Work or school computers may block Developer mode.

### 📤 Sending it to a friend
Send the `MessengerMessageSaver-v1.2.0-share.zip` file as it is, and send its fingerprint (in `dist/SHA256SUMS.txt`) separately. Your friend can check the fingerprint in PowerShell, replacing the path with where the file really is. This shows the file's SHA-256 fingerprint, which must match the one you sent:

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\MessengerMessageSaver-v1.2.0-share.zip"
```

Nothing of yours is inside the ZIP. Your saved messages and settings stay in your own browser.

### Updating
1. Extract the new ZIP.
2. Open its `MessengerMessageSaver` folder and copy everything inside it over your existing folder (choose *Replace the files*).
3. Press the **↻ reload** arrow on the extension's card in `chrome://extensions`, then reload open Facebook tabs.

Your saved messages stay, because the folder path and therefore the extension's ID stay the same. Or, in PowerShell, replacing both paths with yours, this copies the new files over the old ones:

```powershell
robocopy "$env:USERPROFILE\Downloads\MessengerMessageSaver-v1.2.0-share\MessengerMessageSaver" "$env:USERPROFILE\MessengerMessageSaver" /E
```

### Uninstalling
Click **Remove** on the extension's card. This also deletes everything it saved, so download a backup first if you want to keep it.

## 🖱️ Using it

- **Toolbar icon:** quick switches (Save, Unseen, Hide typing, alerts, photos, download buttons), the **EN | বাং** language switch, counts, and the latest unsent messages. The red number on the icon counts newly recovered unsent messages.
- **Alt + Shift + U** turns Unseen mode on or off from any tab (change the key at `chrome://extensions/shortcuts`).
- **Open saved messages:** the full page with tabs *Unsent & deleted*, *Chats*, *Edited*, *Notifications*, *Settings* and *Help*.
- In a chat, recovered messages appear right under Messenger's *"unsent a message"* line. Only you can see these boxes.
- **Downloading:** move the pointer onto a photo, video or reel and a **⬇ Photo / ⬇ Video / ⬇ Reel** button appears at its top-right corner. Settings → *Downloads* chooses HD or SD and whether Chrome asks where to save. Download only what you have the right to keep.
- **Delete chat data** (Saved Messages → Chats) removes that chat's messages, photos, unsend/edit history, and the Messenger notification copies titled with the chat's name. Photos that another chat also contains are kept.
- **PIN lock:** Settings → Privacy. Saved Messages locks again after 15 minutes without use, with **🔒 Lock now**, and when the browser closes. After 5 wrong tries you wait 30 seconds. *Forgot PIN?* deletes everything saved and removes the PIN (otherwise the lock would be pointless).

## ⚠️ Limits (read this once)

- **A message can only be recovered if it reached this browser before it was unsent.** Keep facebook.com or messenger.com open in a tab (a chat pop-up or the Messages page). Messages unsent while Facebook was closed on this computer cannot be recovered.
- **End-to-end encrypted chats** (most one-to-one chats now) cannot be read from Messenger's network data, because it is encrypted. For these chats the extension saves what is **shown on screen** and copies of **Messenger notifications**. So the chat (pop-up or page) must have been open, or a notification must have appeared, before the unsend.
- **Unseen in encrypted chats** uses *Strong mode*: Messenger is told the window is not focused, so it does not report "Seen".
  - It works **only on facebook.com/messages and messenger.com**. Read encrypted chats there, not in the small chat pop-ups on the news feed, where an encrypted chat can still send "Seen". (Facebook's whole site shares one "is the user here" signal; faking it everywhere stopped the news feed, Watch and Reels from loading in version 1.0.0.)
  - Side effect on Messenger pages: Messenger may play its message sound or show a notification while you are reading.
  - An extra option (off by default) also reports the tab as hidden. Use it only if Strong mode alone is not enough: with several Facebook tabs open, encrypted chats can stop loading until you reload the tab.
  - Replying to a chat always marks it as seen; that is how Messenger works.
- **Unseen in normal chats** holds "Seen" back by sending Messenger's own last-known read position instead of the new one. If that position is not known yet (for example in a tab that was open before you installed or updated the extension), "Seen" is left alone rather than risk marking the chat unread, and the toolbar popup asks you to reload that tab.
- **Check Unseen once with a friend** before relying on it: ask them to message you, open the chat, and ask whether they see "Seen". Facebook can change how "Seen" is sent at any time.
- **"Typing…"** can only be hidden in normal (non-encrypted) chats.
- **Downloads:** Facebook plays videos through a stream that cannot be saved directly, so the extension uses the ready-made MP4 file Facebook lists for each video. If Facebook lists only separate picture and sound tracks, both are saved (`…-picture-only.mp4` and `…-sound-only.m4a`); VLC plays them, or a video editor joins them. Private videos you cannot open yourself cannot be downloaded.
- **Facebook in other languages:** the "unsent" wording is recognised in English, Bangla and several other languages, and learned on the page for the rest. Message times are read exactly only from English labels; in other languages they are approximate.
- Desktop browsers only (Chrome, Edge, Brave, Opera, Vivaldi); not Firefox, phones or tablets.
- Facebook changes its website often. If something stops working, open **Settings → Diagnostics** on the Saved Messages page.

## 🔒 Privacy and safety

- **Nothing leaves your computer.** No analytics, no servers, no ads, no remote code, no automatic updates. The only network requests the extension makes go to Facebook itself:
  - photos from Facebook's image servers (`fbcdn.net`), so they survive an unsend;
  - when you press a download button, the file you asked for, and if needed that video's own Facebook page to find its file.
- **Where it is stored:** in this browser's storage for the extension, on this computer (IndexedDB). It is **not encrypted**. Anyone who can use your Windows account or this browser profile can read it, and so can malware on the PC. Keep the PC locked (a Windows password, and device encryption or BitLocker if you have it). The PIN lock keeps other people who use the computer out of Saved Messages. It is not disk encryption.
- **No one can reach it from the internet.** Other websites and other extensions cannot talk to it: there is no `externally_connectable` and no `web_accessible_resources`. The downloader accepts only files on Facebook's own servers. Saved text is never turned into page code. The exported web page cannot run scripts (it carries a Content-Security-Policy). Restored backups are checked field by field.
- **Only install a copy you trust**, and check its fingerprint. Extensions like this run inside facebook.com, so an edited copy could steal a Facebook login.
- **Facebook can tell the extension is installed.** Tools that hide "Seen" go against Meta's terms in principle. There is no known case of accounts being banned for read-receipt blockers, but the risk is not zero.
- Text shown inside Facebook's own page (the recovered-message boxes) is readable by Facebook's scripts too. Turn off *Show unsent messages inside the chat* if that matters to you.
- **Permissions:**
  - `storage` + `unlimitedStorage`: saving.
  - `notifications`: unsend alerts.
  - `alarms`: auto-delete old messages.
  - `scripting`: start working in tabs that were open before an install or update.
  - `downloads` + `contextMenus`: the downloader and its right-click entry.
  - Access to `facebook.com`, `messenger.com` and `fbcdn.net`.
- Please respect other people's privacy: keep what you save for yourself.

## 🛠️ How it works (for the curious)

| Part | File | Job |
|---|---|---|
| Page hook | `extension/content/main-world.js` | Runs inside the Facebook page before Facebook's own code. **Reads** Messenger's sync data: the *LightSpeed* format, carried over the `gateway.facebook.com` WebSocket, the older MQTT socket and Messenger GraphQL replies. Replies are recognised by their query name, so news-feed traffic is never copied. **Rewrites** your own outgoing *mark read* (tasks 21 and 49) and *typing* requests when Unseen is on. Read markers are only ever rewound to what the server already has: never dropped (that could block sending) and never lowered further (that would mark the chat unread). **Strong mode** follows Facebook's in-page navigation and hands the real focus back when you leave Messenger. **For downloads** it reads, and never changes, React's data on the photo or video you point at. |
| Content script | `extension/content/content.js` | Reads messages shown on screen (`[role="log"]` → `[data-scope="messages_table"]` rows), notices when a row turns into *"unsent a message"*, and shows the saved original under it. Shows the ⬇ button, and saves files from encrypted chats that exist only inside the tab. |
| Background worker | `extension/background/service-worker.js` | Stores everything in IndexedDB, matches placeholders to originals, downloads photos, shows alerts. |
| Shared rules | `extension/lib/` | Database (`db.js`), English/Bangla text (`i18n.js`), PIN lock (`lock.js`), checks on untrusted data (`sanitize.js`), download rules (`downloads.js`). |
| Pages | `extension/popup/`, `extension/dashboard/` | Toolbar popup and the Saved Messages page. |

## 🏪 Chrome Web Store

`store/` has everything needed to publish it yourself: listing text (English and Bangla), privacy policy, privacy-practices answers, screenshots, and step-by-step instructions with the review risks in `store/HOW-TO-PUBLISH.md`. The upload file is `dist/MessageSaverForMessenger-v1.2.0-webstore.zip`.

## 🧪 Development

```bash
npm test                # unit tests + end-to-end tests in headless Chromium (needs Playwright)
npm run package         # builds the share ZIP, the Web Store ZIP and SHA256SUMS.txt in dist/
npm run store-assets    # re-creates the Web Store screenshots from demo data
npm run icons           # re-renders the icons from scripts/icon.svg
```

The end-to-end tests load the real extension into Chromium, serve a test double of the Messenger page on `https://www.facebook.com/` and a fake gateway WebSocket. They check:
- saving, unsend recovery (live and after reload), edits and photos;
- Unseen (Seen + typing), and Strong mode staying off the news feed;
- downloads, and that planted data stays harmless;
- the Bangla interface and the PIN lock;
- update and disable of an open tab, and that the release ZIPs install.

Video field names follow the open-source [yt-dlp](https://github.com/yt-dlp/yt-dlp) Facebook extractor; protocol details follow the open-source [mautrix-meta](https://github.com/mautrix/meta) Messenger bridge (both as of November 2026).
