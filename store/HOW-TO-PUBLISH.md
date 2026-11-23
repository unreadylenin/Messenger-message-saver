# Publishing on the Chrome Web Store

With a store listing, anyone can install the extension with one click, and it updates itself.
Only you can do this: it needs your own Google account. Everything to paste or upload is in this folder.

> Store rules and screens change. Check each step against the live Developer Dashboard
> (rules last checked November 2026).

## 1. What you need
- A Google account for the developer account. A separate one is fine.
- The **one-time registration fee**: USD 5 according to Google's help pages. The dashboard shows the current amount.
- A **public web address for the privacy policy** (`privacy-policy.md`). For example, publish it with GitHub Pages or a public GitHub Gist. If this repository is private, a link into it will not work for reviewers.
- The upload file: `dist/MessageSaverForMessenger-v1.2.0-webstore.zip` (built by `npm run package`).

## 2. Create the developer account
1. Open <https://chrome.google.com/webstore/devconsole> and sign in.
2. Accept the developer agreement and pay the registration fee.
3. Verify your contact e-mail.
4. **Trader or non-trader** (required for everyone). Someone sharing a free extension as a hobby usually declares *non-trader*. A *trader* must publish a legal name and contact details on the listing. This is your own legal decision.

## 3. Upload
1. **New item** → upload the webstore ZIP.
2. **Store listing** tab:
   - Paste the texts from `listing.en.md`.
   - Add Bangla: *Add language → Bengali*, then paste `listing.bn.md`.
   - Category: the closest one, for example *Social networking* or *Communication*.
   - Graphics:
     - Icon: `extension/icons/icon128.png`.
     - Screenshots: `screenshots/*.jpg` (1280×800).
     - Small promo tile: `promo-small-440x280.jpg`.
3. **Privacy practices** tab: copy the answers from `privacy-practices.md`, and add the privacy policy's public address.
4. **Distribution**:
   - **Unlisted**: only people with the link can find and install it. Good for friends.
   - **Public**: everyone can find it.
   - **Private**: only listed testers.
5. **Submit for review.** Reviews usually take a few days. Google e-mails the result.

After approval, send friends the store link. An update means: raise the version in `extension/manifest.json` and `package.json`, run `npm run package`, then upload the new webstore ZIP to the same item.

> A store copy is a **different extension** from the unpacked copy (it has a different ID), so its saved messages start empty. To move them: in the old copy, *Settings → Download backup (with photos)*. In the store copy, *Restore a backup…*. Then remove the old copy.

## 4. What could get it rejected, and what to do

The relevant rules are the Chrome Web Store *Program Policies*. The *Limited Use* and *Disclosure* rules were tightened on 1 July 2026 and are enforced from 1 August 2026.

| Rule | Why it matters here | What this kit already does | If it is rejected |
|---|---|---|---|
| **Single purpose**: "a single purpose that is narrow and easy to understand… no bundles of unrelated functionality" | **Biggest risk.** Saving chats, Unseen and the media downloader are bundled. | The purpose is worded as *"keep a private copy of your own Messenger chats and media on your computer"*; every feature is presented as part of that. | Answer the reviewer, explaining the single purpose. If they insist, publish a smaller "saving only" edition (the downloader and Unseen switched off and removed). Ask Claude to build it. |
| **Limited use / disclosure**: data must be strictly necessary and prominently disclosed before installing | It handles personal messages. | The listing, the privacy policy and the extension's first page say what is stored, where, that it is not encrypted, and that nothing is sent. | Point the reviewer to the exact sentences. |
| **Intellectual property**: no "unauthorized… download… of copyrighted content" | The video and photo downloader. Downloaders "may be restricted from feature" but stay available. | The listing and Settings say "download only what you have the right to keep". | Remove the downloader in a store edition. |
| **Impersonation**: no suggestion it is made or endorsed by another company | "Messenger" and "Facebook" are Meta's trademarks. | The store name is *Message Saver for Messenger*, and every listing says *not affiliated with Meta*. | Change the name in `scripts/package.js` (`STORE_NAME`), rebuild, re-upload. |
| **Deceptive behaviour**: "all functionalities… clearly disclosed, no surprises" | Unseen changes what other people see. | The listing names Unseen, Strong mode and hide-typing plainly, including their side effects. | — |

Meta could also complain to Google about a Messenger tool. That is outside your control.
