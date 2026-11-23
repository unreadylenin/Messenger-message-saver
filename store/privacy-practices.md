# Privacy practices tab: answers to paste

## Single purpose
Keep a private copy of your own Messenger chats and their media on your computer, so messages and photos stay readable after the sender unsends or deletes them. The related reading controls (hiding read receipts and typing) and the download button for photos and videos all serve the same purpose: reading and keeping your own conversations and media privately.

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings and small counters. |
| `unlimitedStorage` | The saved chats and their photos are stored locally in IndexedDB and can grow beyond the default quota. |
| `notifications` | Optional desktop alert when someone unsends or edits a message, and confirmation of the Unseen keyboard shortcut. |
| `alarms` | Runs the optional "delete messages older than N days" clean-up, and retries photo copies that failed. |
| `scripting` | After the extension is installed or updated, starts its scripts in Facebook/Messenger tabs that were already open, so the user does not have to reload them. |
| `downloads` | Saves the photo, video or reel the user explicitly asks to download (button or right-click entry). Only files on Facebook's own servers are accepted. |
| `contextMenus` | Adds the "Download this photo or video" right-click entry on Facebook pages. |
| Host `https://*.facebook.com/*`, `https://*.messenger.com/*` | The extension's whole function: read the Messenger chats the user has open and show saved originals under unsent messages. Also used to read a video's own page when the user downloads it. |
| Host `https://*.fbcdn.net/*` | Facebook's image and video servers: copies the photos of the user's chats so they survive an unsend, and downloads files the user asks for. |

## Remote code
**No.** All code is in the package. Nothing is loaded or run from the network.

## Data usage: what to tick
The extension **handles** the following, stored only on the user's device and never transmitted. Tick these so the disclosure is complete:
- **Personal communications** (message text, photos in chats, copies of Messenger notifications).
- **Personally identifiable information** (names of people in the user's chats, as shown by Messenger).
- **Website content** (photos and videos the user chooses to download).

Not collected: health, financial or payment information, authentication information, location, web history, user activity.

If the form asks whether data is *transmitted* or *collected* by the developer, the answer is that it is **not transmitted off the device**. The policy text has no on-device exemption, so the data types are still disclosed above.

## Certifications (all true)
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL
The public address where `store/privacy-policy.md` is published (see HOW-TO-PUBLISH.md).
