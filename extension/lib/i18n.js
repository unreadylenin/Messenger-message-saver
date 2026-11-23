/*
 * Messenger Message Saver - interface text in English and Bangla (বাংলা).
 *
 * One classic script shared by every part of the extension:
 *   - the background worker: `import '../lib/i18n.js'`
 *   - the popup and Saved Messages pages: imported by lib/format.js
 *   - the content script on Facebook: listed before content.js in the manifest
 *   - Node tests: require()
 * It keeps no state (each part remembers its own language), so loading it twice is harmless.
 *
 * Each entry is [English, Bangla]. English is the original wording. Text marked "rich" may
 * contain only <b>…</b> and <i>…</i>; it is built with createElement, never parsed as HTML.
 * {name} is filled in by translate(); numbers are written with Bengali digits in Bangla.
 */
(function (root) {
  'use strict';

  const S = {
    /* ---------- shared words ---------- */
    you: ['You', 'আপনি'],
    unknown: ['Unknown', 'অজানা'],
    unknownChat: ['Unknown chat', 'অজানা চ্যাট'],
    chatN: ['Chat {key}', 'চ্যাট {key}'],
    justNow: ['just now', 'এইমাত্র'],
    minutesAgo: ['{n}m ago', '{n} মিনিট আগে'],
    hoursAgo: ['{n}h ago', '{n} ঘণ্টা আগে'],
    daysAgo: ['{n}d ago', '{n} দিন আগে'],
    'att.voiceTitle': ['Voice message', 'ভয়েস মেসেজ'],
    'att.videoTitle': ['Video', 'ভিডিও'],
    'att.video': ['video', 'ভিডিও'],
    'att.voice': ['voice message', 'ভয়েস মেসেজ'],
    'att.file': ['file', 'ফাইল'],
    'att.attachment': ['attachment', 'অ্যাটাচমেন্ট'],
    'att.photoOrAttachment': ['[photo / attachment]', '[ছবি / অ্যাটাচমেন্ট]'],

    /* ---------- Saved Messages page: header, tabs ---------- */
    'page.title': ['Saved Messages', 'সেভ করা মেসেজ'],
    'search.ph': ['Search all saved messages…', 'সেভ করা সব মেসেজে খুঁজুন…'],
    'tab.unsent': ['Unsent & deleted', 'আনসেন্ড ও ডিলিট'],
    'tab.chats': ['Chats', 'চ্যাট'],
    'tab.edited': ['Edited', 'এডিট করা'],
    'tab.notifications': ['Notifications', 'নোটিফিকেশন'],
    'tab.settings': ['Settings', 'সেটিংস'],
    'tab.help': ['Help', 'সাহায্য'],
    totals: ['{messages} messages saved · {unsent} unsent kept · {edited} edited · {media} photos', '{messages}টি মেসেজ সেভ · {unsent}টি আনসেন্ড রাখা · {edited}টি এডিট · {media}টি ছবি'],
    'paused.banner': ['⏸️ Messenger Message Saver is paused: nothing is saved, and others can see “Seen” and “typing…”.', '⏸️ Messenger Message Saver বন্ধ আছে: কিছুই সেভ হচ্ছে না, আর অন্যরা “Seen” ও “typing…” দেখতে পাচ্ছে।'],
    'paused.switchTitle': ['Turn everything back on', 'সব আবার চালু করুন'],
    'paused.switchAria': ['Turn Messenger Message Saver on', 'Messenger Message Saver চালু করুন'],

    /* ---------- welcome (first start) ---------- */
    'welcome.title': ["You're set up 🎉", 'সব সেট হয়ে গেছে 🎉'],
    'welcome.lang': ['Language:', 'ভাষা:'],
    'welcome.1': ['<b>Reload</b> any Facebook or Messenger tab that was already open.', 'আগে থেকে খোলা Facebook বা Messenger ট্যাবগুলো একবার <b>রিলোড</b> করুন।'],
    'welcome.2': ['Chat as usual. Messages are saved on this computer as they arrive or appear on screen.', 'আগের মতোই চ্যাট করুন। মেসেজ আসার সাথে সাথে বা স্ক্রিনে দেখা গেলেই এই কম্পিউটারে সেভ হয়ে যায়।'],
    'welcome.3': ['When someone unsends, the original appears right under <i>“unsent a message”</i>, and here.', 'কেউ আনসেন্ড করলে আসল মেসেজটি <i>“unsent a message”</i> লেখার ঠিক নিচে আর এখানে দেখা যাবে।'],
    'welcome.4': ["<b>Unseen mode</b> is on: people won't see “Seen” when you read. Turn it off any time from the toolbar icon.", '<b>Unseen মোড</b> চালু আছে: আপনি পড়লেও অন্যরা “Seen” দেখবে না। টুলবারের আইকন থেকে যেকোনো সময় বন্ধ করতে পারবেন।'],
    'welcome.storesTitle': ['What this stores, and where', 'কী সেভ হয়, আর কোথায়'],
    'welcome.stores': [
      'Your Messenger messages, photos and copies of Messenger notifications are saved <b>only on this computer</b>, inside this browser. Nothing is sent anywhere. The copy is <b>not encrypted</b>: anyone who can use this Windows account and browser can open it, so keep the PC locked (Settings → Privacy can add a PIN). You can delete everything any time in Settings.',
      'আপনার Messenger মেসেজ, ছবি আর Messenger নোটিফিকেশনের কপি <b>শুধু এই কম্পিউটারে</b>, এই ব্রাউজারের ভেতরে সেভ হয়। কোথাও কিছু পাঠানো হয় না। কপিটি <b>এনক্রিপ্ট করা নয়</b>: এই Windows অ্যাকাউন্ট আর ব্রাউজার যে ব্যবহার করতে পারে সে-ই এটা খুলতে পারবে, তাই পিসি লক রাখুন (সেটিংস → প্রাইভেসি থেকে পিন দিতে পারবেন)। সেটিংস থেকে যেকোনো সময় সব মুছে ফেলা যায়।',
    ],
    'welcome.ok': ['Got it', 'বুঝেছি'],

    /* ---------- views ---------- */
    'unsent.title': ['Unsent & deleted messages', 'আনসেন্ড ও ডিলিট করা মেসেজ'],
    'unsent.recovered': ['Recovered', 'ফেরত পাওয়া'],
    'unsent.all': ['All (incl. not captured)', 'সব (সেভ না হওয়াগুলোসহ)'],
    'chats.find': ['Find a chat…', 'চ্যাট খুঁজুন…'],
    'chats.pick': ['Pick a chat', 'একটি চ্যাট বেছে নিন'],
    'filter.all': ['All', 'সব'],
    'filter.unsent': ['Unsent', 'আনসেন্ড'],
    'filter.edited': ['Edited', 'এডিট করা'],
    'filter.media': ['Photos', 'ছবি'],
    'chats.export': ['Export chat', 'চ্যাট এক্সপোর্ট'],
    'chats.delete': ['Delete chat data', 'চ্যাটের ডেটা মুছুন'],
    'edited.title': ['Edited messages', 'এডিট করা মেসেজ'],
    'search.title': ['Search', 'খোঁজ'],
    'search.results': ['Results for “{q}”', '“{q}”-এর ফলাফল'],
    'notif.title': ['Messenger notifications', 'Messenger নোটিফিকেশন'],
    'notif.intro': ["A backup copy of Messenger's own desktop notifications (sender and text). Useful when a message was unsent before you opened the chat.", 'Messenger-এর নিজের ডেস্কটপ নোটিফিকেশনের একটি ব্যাকআপ কপি (কে পাঠিয়েছে আর কী লিখেছে)। চ্যাট খোলার আগেই কেউ মেসেজ আনসেন্ড করলে কাজে লাগে।'],
    'notif.fallback': ['Notification', 'নোটিফিকেশন'],
    'empty.unsent': ['No unsent messages yet. When someone unsends a message that reached this browser, it will show up here.', 'এখনো কোনো আনসেন্ড মেসেজ নেই। এই ব্রাউজারে আসা কোনো মেসেজ কেউ আনসেন্ড করলে এখানে দেখা যাবে।'],
    'empty.edited': ['No edited messages saved yet.', 'এখনো কোনো এডিট করা মেসেজ সেভ হয়নি।'],
    'empty.notifications': ['No Messenger notifications captured yet.', 'এখনো কোনো Messenger নোটিফিকেশন রাখা হয়নি।'],
    'empty.noChatMatch': ['No chat matches.', 'মেলে এমন কোনো চ্যাট নেই।'],
    'empty.noChats': ['No chats saved yet.', 'এখনো কোনো চ্যাট সেভ হয়নি।'],
    'empty.pickChat': ['Choose a chat on the left.', 'বাঁ দিক থেকে একটি চ্যাট বেছে নিন।'],
    'empty.filter': ['Nothing to show with this filter.', 'এই ফিল্টারে দেখানোর মতো কিছু নেই।'],
    'empty.search': ['No saved message contains that.', 'এমন লেখা কোনো সেভ করা মেসেজে নেই।'],
    'thread.saved': ['{n} saved', '{n}টি সেভ'],
    'thread.unsent': ['{n} unsent', '{n}টি আনসেন্ড'],
    'thread.edited': ['{n} edited', '{n}টি এডিট'],

    /* ---------- message cards ---------- */
    lightbox: ['Photo (press Escape to close)', 'ছবি (বন্ধ করতে Escape চাপুন)'],
    'media.notSaved': ['🖼️ photo (not in this browser — it was not saved, or not included in a restored backup)', '🖼️ ছবি (এই ব্রাউজারে নেই — সেভ হয়নি, অথবা ফিরিয়ে আনা ব্যাকআপে ছিল না)'],
    'media.expired': ['🖼️ photo (link expired, not downloaded)', '🖼️ ছবি (লিংকের মেয়াদ শেষ, ডাউনলোড হয়নি)'],
    'media.savedPhoto': ['saved photo', 'সেভ করা ছবি'],
    'media.photo': ['photo', 'ছবি'],
    'badge.unsent': ['Unsent', 'আনসেন্ড'],
    'badge.deleted': ['Deleted', 'ডিলিট'],
    'badge.edited': ['Edited', 'এডিট'],
    'badge.e2ee': ['🔒 encrypted chat', '🔒 এনক্রিপ্টেড চ্যাট'],
    'history.earlier': ['Earlier versions:', 'আগের লেখা:'],
    'copy.btn': ['Copy text', 'লেখা কপি'],
    'copy.ok': ['Copied', 'কপি হয়েছে'],
    'copy.fail': ['Could not copy', 'কপি করা গেল না'],
    'card.in': ['in {chat}', '{chat} চ্যাটে'],
    'card.openChat': ['open chat', 'চ্যাট খুলুন'],
    'card.openChatTitle': ['Open this chat', 'এই চ্যাটটি খুলুন'],
    'card.saved': ['saved {time}', 'সেভ {time}'],
    'card.sent': ['sent {time}', 'পাঠানো {time}'],
    'card.notCaptured': ['This message was unsent before the extension could save it.', 'এক্সটেনশন সেভ করার আগেই মেসেজটি আনসেন্ড করা হয়েছে।'],
    'card.noText': ['(no text)', '(লেখা নেই)'],
    'bubble.approx': [' (saved)', ' (সেভের সময়)'],
    'bubble.unsentEmpty': ['Unsent before it could be saved.', 'সেভ হওয়ার আগেই আনসেন্ড হয়েছে।'],

    /* ---------- settings ---------- */
    saved: ['Saved', 'সেভ হয়েছে'],
    'set.saving': ['Saving', 'সেভ করা'],
    'set.enabled': ['Messenger Message Saver is on', 'Messenger Message Saver চালু'],
    'set.enabled.hint': ['Turn off to pause everything (saving and Unseen)', 'বন্ধ করলে সব থেমে যাবে (সেভ করা আর Unseen)'],
    'set.saveMessages': ['Save messages', 'মেসেজ সেভ করুন'],
    'set.captureNetwork': ["Read Messenger's own data (normal chats)", 'Messenger-এর নিজের ডেটা পড়ুন (সাধারণ চ্যাট)'],
    'set.captureNetwork.hint': ['Catches messages even before you open the chat', 'চ্যাট খোলার আগেই মেসেজ ধরে রাখে'],
    'set.captureDom': ['Read messages shown on screen', 'স্ক্রিনে দেখানো মেসেজ পড়ুন'],
    'set.captureDom.hint': ['Needed for end-to-end encrypted chats', 'এন্ড-টু-এন্ড এনক্রিপ্টেড চ্যাটের জন্য দরকার'],
    'set.captureNotifications': ['Keep copies of Messenger notifications', 'Messenger নোটিফিকেশনের কপি রাখুন'],
    'set.saveMedia': ['Save photos and stickers', 'ছবি আর স্টিকার সেভ করুন'],
    'set.maxMediaMB': ['Largest photo to keep (MB)', 'সবচেয়ে বড় কত MB-এর ছবি রাখবে'],
    'set.maxMediaMB.hint': ['Up to 40 MB', '৪০ MB পর্যন্ত'],
    'set.retentionDays': ['Delete saved messages older than (days)', 'এর চেয়ে পুরোনো সেভ করা মেসেজ মুছে দিন (দিন)'],
    'set.retentionDays.hint': ['0 = keep forever', '০ = সবসময় রাখুন'],
    'set.showing': ['Showing', 'দেখানো'],
    'set.showRecoveredInline': ['Show unsent messages inside the chat', 'চ্যাটের ভেতরেই আনসেন্ড মেসেজ দেখান'],
    'set.showEditHistoryInline': ['Show earlier text of edited messages', 'এডিট করা মেসেজের আগের লেখা দেখান'],
    'set.notifyOnUnsend': ['Desktop alert when someone unsends', 'কেউ আনসেন্ড করলে ডেস্কটপ অ্যালার্ট'],
    'set.notifyOnEdit': ['Desktop alert when someone edits', 'কেউ এডিট করলে ডেস্কটপ অ্যালার্ট'],
    'set.badge': ['Count new unsent messages on the toolbar icon', 'টুলবারের আইকনে নতুন আনসেন্ড মেসেজের সংখ্যা দেখান'],
    'set.unseen': ['Unseen', 'Unseen'],
    'set.blockSeen': ['Don’t send “Seen”', '“Seen” পাঠাবেন না'],
    'set.stealthFocus': ['Strong mode for encrypted chats', 'এনক্রিপ্টেড চ্যাটের জন্য Strong mode'],
    'set.stealthFocus.hint': [
      'On facebook.com/messages and messenger.com only, Messenger is told the window is not focused, so it does not report “Seen”. Read encrypted chats there, not in chat pop-ups. Side effect: Messenger may play its message sound or show a notification while you are reading.',
      'শুধু facebook.com/messages আর messenger.com-এ Messenger-কে জানানো হয় যে উইন্ডোটি সামনে নেই, তাই সে “Seen” পাঠায় না। এনক্রিপ্টেড চ্যাট সেখানেই পড়ুন, ছোট চ্যাট পপ-আপে নয়। পার্শ্বপ্রতিক্রিয়া: পড়ার সময়ও Messenger মেসেজের শব্দ বাজাতে বা নোটিফিকেশন দেখাতে পারে।',
    ],
    'set.stealthVisibility': ['Extra: also report the tab as hidden', 'বাড়তি: ট্যাবটিকেও লুকানো হিসেবে জানান'],
    'set.stealthVisibility.hint': ['Only if Strong mode alone is not enough (Messenger pages only). With several Facebook tabs open, encrypted chats can stop loading until you reload the tab.', 'শুধু Strong mode যথেষ্ট না হলে (শুধু Messenger পেজে)। কয়েকটি Facebook ট্যাব খোলা থাকলে এনক্রিপ্টেড চ্যাট লোড হওয়া থেমে যেতে পারে, ট্যাব রিলোড না করা পর্যন্ত।'],
    'set.blockTyping': ['Don’t show “typing…”', '“typing…” দেখাবেন না'],
    'set.blockTyping.hint': ['Works in normal (not end-to-end encrypted) chats', 'সাধারণ (এন্ড-টু-এন্ড এনক্রিপ্টেড নয়) চ্যাটে কাজ করে'],
    'set.unseen.note': ['Replying to a chat always shows “Seen” - that is how Messenger works. Right after installing or updating, reload open Facebook tabs so every chat is covered.', 'কোনো চ্যাটে উত্তর দিলে সবসময় “Seen” দেখায় — Messenger এভাবেই কাজ করে। ইনস্টল বা আপডেটের ঠিক পরে খোলা Facebook ট্যাবগুলো রিলোড করুন, যাতে সব চ্যাট সুরক্ষিত থাকে।'],
    'set.downloads': ['Downloads', 'ডাউনলোড'],
    'set.downloadButtons': ['Download buttons on photos, videos and reels', 'ছবি, ভিডিও আর রিলে ডাউনলোড বাটন'],
    'set.downloadButtons.hint': ['Point at a photo, video or reel on Facebook or Messenger and press “⬇”. Right-click → “Download this photo or video” works too.', 'Facebook বা Messenger-এ কোনো ছবি, ভিডিও বা রিলের ওপর মাউস রেখে “⬇” চাপুন। রাইট-ক্লিক → “এই ছবি বা ভিডিও ডাউনলোড করুন” দিয়েও হয়।'],
    'set.downloadQuality': ['Video quality', 'ভিডিওর মান'],
    'set.downloadQuality.hint': ['HD when Facebook offers it; SD makes smaller files', 'Facebook দিলে HD; SD-তে ফাইল ছোট হয়'],
    'set.q.hd': ['Best (HD)', 'সেরা (HD)'],
    'set.q.sd': ['Smaller (SD)', 'ছোট ফাইল (SD)'],
    'set.downloadAsk': ['Ask where to save each file', 'প্রতিটি ফাইল কোথায় রাখবে জিজ্ঞেস করুক'],
    'set.downloadAsk.hint': ['Off: files go to Downloads › Facebook', 'বন্ধ থাকলে: ফাইল যাবে Downloads › Facebook-এ'],
    'set.downloads.note': ['Download only what you have the right to keep, such as your own posts or photos friends sent you.', 'শুধু সেগুলোই ডাউনলোড করুন যেগুলো রাখার অধিকার আপনার আছে, যেমন নিজের পোস্ট বা বন্ধুদের পাঠানো ছবি।'],
    'set.language': ['Language / ভাষা', 'ভাষা / Language'],
    'set.language.label': ['Show this extension in', 'এক্সটেনশনটি দেখাবে'],
    'set.language.hint': ['Automatic follows the browser’s language', 'স্বয়ংক্রিয় মানে ব্রাউজারের ভাষা অনুযায়ী'],
    'set.lang.auto': ['Automatic', 'স্বয়ংক্রিয়'],
    'set.backup': ['Backup', 'ব্যাকআপ'],
    'backup.full': ['Download backup (with photos)', 'ব্যাকআপ ডাউনলোড (ছবিসহ)'],
    'backup.light': ['Download backup (text only)', 'ব্যাকআপ ডাউনলোড (শুধু লেখা)'],
    'backup.html': ['Download as readable web page', 'পড়ার মতো ওয়েব পেজ হিসেবে ডাউনলোড'],
    'backup.csv': ['Download as spreadsheet (CSV)', 'স্প্রেডশিট (CSV) হিসেবে ডাউনলোড'],
    'backup.restore': ['Restore a backup…', 'ব্যাকআপ থেকে ফিরিয়ে আনুন…'],
    'set.danger': ['Danger zone', 'সাবধান'],
    'set.deleteAll': ['Delete everything saved', 'সেভ করা সবকিছু মুছুন'],
    'set.diag': ['Diagnostics', 'ডায়াগনস্টিকস'],
    'set.diag.intro': ['What the extension sees in your open Facebook / Messenger tabs. If “gateway sockets” stays 0, Messenger may have changed how it connects; messages are then saved from the screen only.', 'খোলা Facebook / Messenger ট্যাবে এক্সটেনশন যা দেখছে। “gateway sockets” সবসময় ০ থাকলে হয়তো Messenger সংযোগের ধরন বদলেছে; তখন মেসেজ শুধু স্ক্রিন থেকে সেভ হবে।'],

    /* ---------- settings: privacy (PIN lock) ---------- */
    'privacy.title': ['Privacy', 'প্রাইভেসি'],
    'privacy.intro': ['Lock Saved Messages with a PIN. People who use this computer then cannot open your saved messages, backups or settings without it.', 'পিন দিয়ে সেভ করা মেসেজ লক করুন। তাহলে এই কম্পিউটার যারা ব্যবহার করে, পিন ছাড়া তারা আপনার সেভ করা মেসেজ, ব্যাকআপ বা সেটিংস খুলতে পারবে না।'],
    'privacy.newPin': ['New PIN (4–12 digits)', 'নতুন পিন (৪–১২ সংখ্যা)'],
    'privacy.repeat': ['Type it again', 'আবার লিখুন'],
    'privacy.set': ['Turn on the PIN lock', 'পিন লক চালু করুন'],
    'privacy.on': ['🔒 The PIN lock is on. It locks again after 15 minutes without use and when the browser closes.', '🔒 পিন লক চালু আছে। ১৫ মিনিট ব্যবহার না হলে আর ব্রাউজার বন্ধ হলে আবার লক হয়ে যায়।'],
    'privacy.current': ['Current PIN', 'বর্তমান পিন'],
    'privacy.remove': ['Turn off the PIN lock', 'পিন লক বন্ধ করুন'],
    'privacy.honest': [
      'Honest note: the PIN stops people who use this computer from opening Saved Messages. It does not encrypt the files on the disk, so it cannot stop someone with technical skill or a virus. Do not reuse your phone or bank PIN. The boxes inside Facebook chats follow “Show unsent messages inside the chat”.',
      'সত্যি কথা: পিন দিলে এই কম্পিউটার যারা ব্যবহার করে তারা সেভ করা মেসেজ খুলতে পারবে না। কিন্তু ডিস্কের ফাইল এনক্রিপ্ট হয় না, তাই প্রযুক্তি জানা কেউ বা ভাইরাস ঠেকানো যায় না। ফোন বা ব্যাংকের পিন এখানে ব্যবহার করবেন না। Facebook চ্যাটের ভেতরের বাক্সগুলো “চ্যাটের ভেতরেই আনসেন্ড মেসেজ দেখান” অপশন মেনে চলে।',
    ],
    'privacy.invalid': ['Use 4 to 12 digits.', '৪ থেকে ১২টি সংখ্যা দিন।'],
    'privacy.mismatch': ['The two PINs are not the same.', 'দুটি পিন এক নয়।'],
    'privacy.setDone': ['PIN lock is on', 'পিন লক চালু হয়েছে'],
    'privacy.removed': ['PIN lock is off', 'পিন লক বন্ধ হয়েছে'],
    'privacy.removeWrong': ['Wrong PIN: the lock stays on.', 'পিন ভুল: লক চালুই থাকল।'],
    'lock.title': ['Saved messages are locked', 'সেভ করা মেসেজ লক করা আছে'],
    'lock.label': ['Enter your PIN', 'আপনার পিন দিন'],
    'lock.submit': ['Unlock', 'আনলক'],
    'lock.checking': ['Checking…', 'যাচাই হচ্ছে…'],
    'lock.wrong': ['Wrong PIN.', 'পিন ভুল।'],
    'lock.wait': ['Too many wrong tries. Try again in {s} seconds.', 'অনেকবার ভুল হয়েছে। {s} সেকেন্ড পরে আবার চেষ্টা করুন।'],
    'lock.forgot': ['Forgot PIN?', 'পিন ভুলে গেছেন?'],
    'lock.forgotConfirm': ['Without the PIN the saved messages cannot be opened. Delete EVERYTHING saved (messages, photos, history) and remove the PIN? This cannot be undone.', 'পিন ছাড়া সেভ করা মেসেজ খোলা যাবে না। সেভ করা সবকিছু (মেসেজ, ছবি, ইতিহাস) মুছে পিন সরিয়ে দেবেন? এটা আর ফেরানো যাবে না।'],
    'lock.forgotOk': ['Delete everything and remove the PIN', 'সব মুছে পিন সরান'],
    'lock.honest': ['The PIN keeps other people who use this computer out of Saved Messages. It does not encrypt the files on the disk.', 'পিন এই কম্পিউটারের অন্য ব্যবহারকারীদের সেভ করা মেসেজ থেকে দূরে রাখে। এটি ডিস্কের ফাইল এনক্রিপ্ট করে না।'],
    'lock.now': ['🔒 Lock now', '🔒 এখনই লক করুন'],

    /* ---------- toasts and dialogs ---------- */
    'backup.preparing': ['Preparing backup…', 'ব্যাকআপ তৈরি হচ্ছে…'],
    'backup.readyPhotos': ['Backup ready ({n} photos)', 'ব্যাকআপ তৈরি ({n}টি ছবি)'],
    'backup.ready': ['Backup ready', 'ব্যাকআপ তৈরি'],
    'backup.failed': ['Backup failed: {error}', 'ব্যাকআপ হয়নি: {error}'],
    'export.preparing': ['Preparing page…', 'পেজ তৈরি হচ্ছে…'],
    'export.failed': ['Export failed: {error}', 'এক্সপোর্ট হয়নি: {error}'],
    'restore.running': ['Restoring…', 'ফিরিয়ে আনা হচ্ছে…'],
    'restore.progress': ['Restoring… {n} photos so far', 'ফিরিয়ে আনা হচ্ছে… এ পর্যন্ত {n}টি ছবি'],
    'restore.done': ['Restored {messages} messages, {media} photos', '{messages}টি মেসেজ আর {media}টি ছবি ফিরিয়ে আনা হয়েছে'],
    'restore.failed': ['Restore failed: {error}', 'ফিরিয়ে আনা যায়নি: {error}'],
    'restore.notBackup': ['This file is not a Messenger Message Saver backup.', 'এই ফাইলটি Messenger Message Saver-এর ব্যাকআপ নয়।'],
    'restore.badLayout': ['This backup is too large to restore in one piece and is not in the expected layout.', 'ব্যাকআপটি একবারে ফিরিয়ে আনার জন্য খুব বড়, আর এর গঠনও প্রত্যাশিত নয়।'],
    'dlg.cancel': ['Cancel', 'বাতিল'],
    'dlg.delete': ['Delete', 'মুছুন'],
    'confirm.deleteChat': ['Delete everything saved from “{chat}”: messages, photos, unsend and edit history, and Messenger notification copies from this chat? This cannot be undone.', '“{chat}” থেকে সেভ করা সবকিছু মুছবেন: মেসেজ, ছবি, আনসেন্ড ও এডিটের ইতিহাস, আর এই চ্যাটের Messenger নোটিফিকেশনের কপি? এটা আর ফেরানো যাবে না।'],
    'confirm.deleteAll': ['Delete ALL saved messages, photos and history? This cannot be undone. (Tip: download a backup first.)', 'সেভ করা সব মেসেজ, ছবি আর ইতিহাস মুছবেন? এটা আর ফেরানো যাবে না। (পরামর্শ: আগে একটি ব্যাকআপ ডাউনলোড করে নিন।)'],
    'confirm.deleteAllOk': ['Delete everything', 'সব মুছুন'],
    'deleted.chat': ['Chat data deleted', 'চ্যাটের ডেটা মুছে ফেলা হয়েছে'],
    'deleted.all': ['Everything deleted', 'সব মুছে ফেলা হয়েছে'],
    error: ['Error: {error}', 'সমস্যা: {error}'],

    /* ---------- diagnostics ---------- */
    'diag.tab': ['Tab', 'ট্যাব'],
    'diag.sockets': ['Gateway sockets', 'Gateway সংযোগ'],
    'diag.network': ['Network messages', 'নেটওয়ার্কের মেসেজ'],
    'diag.screen': ['On-screen', 'স্ক্রিনে'],
    'diag.blocked': ['Seen / typing blocked', 'Seen / typing আটকানো'],
    'diag.problems': ['Problems', 'সমস্যা'],
    'diag.socketsRow': ['{dgw} gateway, {mqtt} legacy, {e2ee} encrypted', '{dgw} gateway, {mqtt} পুরোনো, {e2ee} এনক্রিপ্টেড'],
    'diag.networkRow': ['{messages} msgs, {unsent} unsends, {edits} edits', '{messages} মেসেজ, {unsent} আনসেন্ড, {edits} এডিট'],
    'diag.screenRow': ['{logs} chat(s) open, {saved} saved, {recovered} shown', '{logs}টি চ্যাট খোলা, {saved} সেভ, {recovered} দেখানো'],
    'diag.notHeld': [' ({n} not held back: reload this tab)', ' ({n}টি আটকানো যায়নি: এই ট্যাব রিলোড করুন)'],
    'diag.late': [' · started late: reload this tab', ' · দেরিতে শুরু হয়েছে: এই ট্যাব রিলোড করুন'],
    'diag.strong': [' · Strong mode on here', ' · এখানে Strong mode চালু'],
    'diag.none': ['none', 'নেই'],
    'diag.noTabs': ['No Facebook or Messenger tab has reported yet. Open (or reload) one.', 'এখনো কোনো Facebook বা Messenger ট্যাব রিপোর্ট করেনি। একটি খুলুন (বা রিলোড করুন)।'],
    'diag.sinceInstall': ['Since install: {seen} “Seen” and {typing} “typing” signals blocked in normal chats.', 'ইনস্টলের পর থেকে: সাধারণ চ্যাটে {seen}টি “Seen” আর {typing}টি “typing” সংকেত আটকানো হয়েছে।'],

    /* ---------- exported web page ---------- */
    'export.title': ['Saved Messenger messages', 'সেভ করা Messenger মেসেজ'],
    'export.by': ['Exported {time} by Messenger Message Saver.', '{time}-এ Messenger Message Saver দিয়ে এক্সপোর্ট করা।'],
    'export.before': ['before: {text}', 'আগে: {text}'],
    'export.unsent': ['UNSENT', 'আনসেন্ড'],
    'export.deleted': ['DELETED', 'ডিলিট'],
    'export.edited': ['EDITED', 'এডিট'],
    'export.photoInBackup': ['photo (in the JSON backup)', 'ছবি (JSON ব্যাকআপে আছে)'],
    'export.unsentEmpty': ['Unsent before it could be saved.', 'সেভ হওয়ার আগেই আনসেন্ড হয়েছে।'],

    /* ---------- help ---------- */
    'help.how': ['How it works', 'কীভাবে কাজ করে'],
    'help.saving': ["<b>Saving.</b> While a Facebook or Messenger tab is open, the extension keeps a private copy of messages: from Messenger's own data for normal chats, and from what is shown on screen for every chat (including end-to-end encrypted ones). Everything stays on this computer.", '<b>সেভ করা।</b> Facebook বা Messenger ট্যাব খোলা থাকলে এক্সটেনশন মেসেজের একটি ব্যক্তিগত কপি রাখে: সাধারণ চ্যাটের জন্য Messenger-এর নিজের ডেটা থেকে, আর সব চ্যাটের জন্য (এন্ড-টু-এন্ড এনক্রিপ্টেডসহ) স্ক্রিনে যা দেখা যায় তা থেকে। সবকিছু এই কম্পিউটারেই থাকে।'],
    'help.unsent': ['<b>Unsent messages.</b> When someone unsends, Messenger shows “… unsent a message”. The saved original appears right under it, in the <i>Unsent &amp; deleted</i> tab, and as a desktop alert.', '<b>আনসেন্ড মেসেজ।</b> কেউ আনসেন্ড করলে Messenger দেখায় “… unsent a message”। সেভ করা আসল মেসেজটি তার ঠিক নিচে, <i>আনসেন্ড ও ডিলিট</i> ট্যাবে, আর ডেস্কটপ অ্যালার্টে দেখা যায়।'],
    'help.edited': ['<b>Edited messages.</b> Earlier versions are kept and shown under the edited message.', '<b>এডিট করা মেসেজ।</b> আগের লেখাগুলো রাখা হয় আর এডিট করা মেসেজের নিচে দেখানো হয়।'],
    'help.unseen': ['<b>Unseen.</b> “Seen” is not sent when you read. In normal chats the read marker is held back everywhere. In encrypted chats this works through <i>Strong mode</i>, which tells Messenger the window is not focused; it runs only on facebook.com/messages and messenger.com, so read encrypted chats there rather than in the small chat pop-ups. Check it once with a friend.', '<b>Unseen।</b> আপনি পড়লে “Seen” যায় না। সাধারণ চ্যাটে সব জায়গায় পড়ার চিহ্ন আটকে রাখা হয়। এনক্রিপ্টেড চ্যাটে এটা কাজ করে <i>Strong mode</i>-এর মাধ্যমে, যা Messenger-কে জানায় উইন্ডোটি সামনে নেই; এটি শুধু facebook.com/messages আর messenger.com-এ চলে, তাই এনক্রিপ্টেড চ্যাট ছোট পপ-আপে না পড়ে সেখানে পড়ুন। একবার কোনো বন্ধুর সাথে পরীক্ষা করে নিন।'],
    'help.downloads': ['<b>Downloads.</b> Point at a photo, video or reel and press the “⬇” button that appears on it (or right-click → “Download this photo or video”). Videos are saved in HD with sound when Facebook offers it; photos at the largest size the page has. Files go to Downloads › Facebook.', '<b>ডাউনলোড।</b> কোনো ছবি, ভিডিও বা রিলের ওপর মাউস রাখলে যে “⬇” বাটন আসে সেটি চাপুন (অথবা রাইট-ক্লিক → “এই ছবি বা ভিডিও ডাউনলোড করুন”)। Facebook দিলে ভিডিও HD-তে শব্দসহ সেভ হয়; ছবি পেজে থাকা সবচেয়ে বড় আকারে। ফাইল যায় Downloads › Facebook-এ।'],
    'help.language': ['<b>Language.</b> Settings → Language switches the extension between English and Bangla.', '<b>ভাষা।</b> সেটিংস → ভাষা থেকে এক্সটেনশনটি ইংরেজি বা বাংলায় দেখাতে পারবেন।'],
    'help.lock': ['<b>PIN lock.</b> Settings → Privacy can lock Saved Messages with a PIN, so other people who use this computer cannot open them.', '<b>পিন লক।</b> সেটিংস → প্রাইভেসি থেকে পিন দিয়ে সেভ করা মেসেজ লক করা যায়, যাতে এই কম্পিউটারের অন্য ব্যবহারকারীরা খুলতে না পারে।'],
    'help.limits': ['Limits', 'সীমাবদ্ধতা'],
    'help.lim1': ['A message can only be recovered if it reached this browser before it was unsent: Messenger must have been open in a tab (a chat pop-up or the Messages page). Messages unsent while Facebook was closed cannot be recovered.', 'আনসেন্ডের আগে মেসেজটি এই ব্রাউজারে পৌঁছালেই শুধু ফেরত পাওয়া যায়: Messenger কোনো ট্যাবে খোলা থাকতে হবে (চ্যাট পপ-আপ বা Messages পেজ)। Facebook বন্ধ থাকার সময় আনসেন্ড হওয়া মেসেজ ফেরত পাওয়া যায় না।'],
    'help.lim2': ['In end-to-end encrypted chats the message must have been <b>shown on screen</b> at least once (the chat pop-up or chat page was open), or have arrived as a Messenger notification.', 'এন্ড-টু-এন্ড এনক্রিপ্টেড চ্যাটে মেসেজটি অন্তত একবার <b>স্ক্রিনে দেখা যেতে</b> হবে (চ্যাট পপ-আপ বা চ্যাট পেজ খোলা ছিল), অথবা Messenger নোটিফিকেশন হিসেবে আসতে হবে।'],
    'help.lim3': ['“Typing…” can only be hidden in normal chats.', '“Typing…” শুধু সাধারণ চ্যাটে লুকানো যায়।'],
    'help.lim4': ['In chat pop-ups on the news feed, encrypted chats can still send “Seen” (Strong mode is kept off there so Facebook’s feed, Watch and Reels keep loading).', 'নিউজ ফিডের চ্যাট পপ-আপে এনক্রিপ্টেড চ্যাট এখনো “Seen” পাঠাতে পারে (সেখানে Strong mode বন্ধ রাখা হয়, যাতে Facebook-এর ফিড, Watch আর Reels ঠিকমতো লোড হয়)।'],
    'help.lim5': ['If Facebook only offers a video as separate picture and sound files, both files are saved; a video player such as VLC can play them, or they can be joined with a video editor.', 'Facebook যদি কোনো ভিডিও শুধু আলাদা ছবি আর শব্দের ফাইলে দেয়, তাহলে দুটোই সেভ হয়; VLC-র মতো ভিডিও প্লেয়ারে চালানো যায়, বা ভিডিও এডিটরে জোড়া লাগানো যায়।'],
    'help.lim6': ['Facebook changes its website often. If something stops working, check <i>Settings → Diagnostics</i>.', 'Facebook প্রায়ই ওয়েবসাইট বদলায়। কিছু কাজ না করলে <i>সেটিংস → ডায়াগনস্টিকস</i> দেখুন।'],
    'help.privacy': ['Privacy', 'প্রাইভেসি'],
    'help.privacyText': ['No data leaves your computer. The extension has no servers and sends nothing anywhere. The saved copy is not encrypted, so keep your Windows account locked. Uninstalling the extension deletes everything it saved.', 'কোনো ডেটা আপনার কম্পিউটারের বাইরে যায় না। এক্সটেনশনের কোনো সার্ভার নেই, কোথাও কিছু পাঠায় না। সেভ করা কপি এনক্রিপ্ট করা নয়, তাই Windows অ্যাকাউন্ট লক রাখুন। এক্সটেনশন আনইনস্টল করলে সেভ করা সবকিছু মুছে যায়।'],

    /* ---------- popup ---------- */
    'popup.loading': ['Loading…', 'লোড হচ্ছে…'],
    'popup.masterTitle': ['Turn everything on or off', 'সব চালু বা বন্ধ করুন'],
    'popup.reloadTab': ['Reload tab', 'ট্যাব রিলোড'],
    'popup.paused': ['⏸️ Paused: nothing is saved, and others can see “Seen” and “typing…”.', '⏸️ বন্ধ আছে: কিছুই সেভ হচ্ছে না, আর অন্যরা “Seen” ও “typing…” দেখতে পাচ্ছে।'],
    'stats.saved': ['saved', 'সেভ'],
    'stats.unsent': ['unsent kept', 'আনসেন্ড রাখা'],
    'stats.edited': ['edited', 'এডিট'],
    'stats.seen': ['Seen held back*', 'আটকানো Seen*'],
    'stats.seenTitle': ['Counts normal chats only. In encrypted chats Strong mode stops “Seen” without counting it.', 'শুধু সাধারণ চ্যাট গোনা হয়। এনক্রিপ্টেড চ্যাটে Strong mode “Seen” আটকায় কিন্তু গোনে না।'],
    'pop.saveMessages': ['Save messages', 'মেসেজ সেভ করুন'],
    'pop.saveMessages.hint': ['Private copy on this computer', 'এই কম্পিউটারে ব্যক্তিগত কপি'],
    'pop.showRecovered': ['Show unsent messages in chat', 'চ্যাটে আনসেন্ড মেসেজ দেখান'],
    'pop.showRecovered.hint': ['Under “unsent a message”', '“unsent a message”-এর নিচে'],
    'pop.unseen': ['Unseen mode', 'Unseen মোড'],
    'pop.unseen.hint': ['Others don’t see “Seen” when you read · Alt+Shift+U', 'আপনি পড়লেও অন্যরা “Seen” দেখবে না · Alt+Shift+U'],
    'pop.strong': ['Strong mode (encrypted chats)', 'Strong mode (এনক্রিপ্টেড চ্যাট)'],
    'pop.strong.hint': ['On facebook.com/messages and messenger.com', 'facebook.com/messages আর messenger.com-এ'],
    'pop.typing': ['Hide “typing…”', '“typing…” লুকান'],
    'pop.typing.hint': ['Others don’t see you typing (normal chats)', 'আপনি টাইপ করছেন অন্যরা দেখবে না (সাধারণ চ্যাট)'],
    'pop.alert': ['Alert when someone unsends', 'কেউ আনসেন্ড করলে অ্যালার্ট'],
    'pop.alert.hint': ['Desktop notification', 'ডেস্কটপ নোটিফিকেশন'],
    'pop.photos': ['Save photos too', 'ছবিও সেভ করুন'],
    'pop.photos.hint': ['Unsent photos stay visible', 'আনসেন্ড করা ছবিও দেখা যাবে'],
    'pop.downloads': ['Download buttons', 'ডাউনলোড বাটন'],
    'pop.downloads.hint': ['On photos, videos and reels', 'ছবি, ভিডিও আর রিলে'],
    'popup.recent': ['Recently unsent', 'সাম্প্রতিক আনসেন্ড'],
    'popup.recentEmpty': ['Nothing unsent yet. Keep Messenger open in a tab and messages will be saved as they arrive.', 'এখনো কিছু আনসেন্ড হয়নি। Messenger কোনো ট্যাবে খোলা রাখুন, মেসেজ এলেই সেভ হয়ে যাবে।'],
    'popup.locked': ['🔒 Saved messages are locked. Open them and enter your PIN.', '🔒 সেভ করা মেসেজ লক করা আছে। খুলে পিন দিন।'],
    'popup.open': ['Open saved messages', 'সেভ করা মেসেজ খুলুন'],
    'popup.settings': ['Settings', 'সেটিংস'],
    'popup.openIn': ['Open in saved messages', 'সেভ করা মেসেজে খুলুন'],
    'state.paused': ['Paused', 'বন্ধ'],
    'state.saving': ['Saving', 'সেভ হচ্ছে'],
    'state.notSaving': ['Not saving', 'সেভ হচ্ছে না'],
    'state.unseenOn': ['Unseen on', 'Unseen চালু'],
    'state.locked': ['Locked', 'লক করা'],
    'hint.reload': ['Reload this Facebook tab once so the extension can start working here.', 'এখানে এক্সটেনশন চালু হতে এই Facebook ট্যাবটি একবার রিলোড করুন।'],
    'hint.late': ['This tab was open before the extension started. Reload it so Unseen covers every chat.', 'এক্সটেনশন চালুর আগে থেকেই এই ট্যাবটি খোলা ছিল। রিলোড করুন, যাতে Unseen সব চ্যাটে কাজ করে।'],
    'hint.seenUnknown': ['“Seen” may have been sent in a chat whose read state was not known yet. Reload this tab to be safe.', 'যে চ্যাটের পড়ার অবস্থা এখনো জানা ছিল না, সেখানে হয়তো “Seen” চলে গেছে। নিরাপদ থাকতে এই ট্যাবটি রিলোড করুন।'],
    'lang.switchTitle': ['Language', 'ভাষা'],

    /* ---------- inside Facebook chats ---------- */
    'box.saved': ['🛡️ Saved copy of the unsent message', '🛡️ আনসেন্ড করা মেসেজের সেভ করা কপি'],
    'box.bestMatch': [' (best match)', ' (সবচেয়ে কাছের মিল)'],
    'box.savedAt': ['saved {time}', 'সেভ {time}'],
    'box.sentAt': ['sent {time}', 'পাঠানো {time}'],
    'box.unsentAt': [' · unsent {time}', ' · আনসেন্ড {time}'],
    'box.title': ['Shown by Messenger Message Saver - only you can see this.', 'Messenger Message Saver দেখাচ্ছে — শুধু আপনি এটা দেখতে পাচ্ছেন।'],
    'box.missing': ['🛡️ No saved copy: this message was unsent before Messenger Message Saver could see it.', '🛡️ সেভ করা কপি নেই: Messenger Message Saver দেখার আগেই মেসেজটি আনসেন্ড করা হয়েছে।'],
    'box.edited': ['✏️ Before editing:', '✏️ এডিটের আগে:'],

    /* ---------- downloads ---------- */
    'dl.photo': ['⬇ Photo', '⬇ ছবি'],
    'dl.video': ['⬇ Video', '⬇ ভিডিও'],
    'dl.reel': ['⬇ Reel', '⬇ রিল'],
    'dl.photoTitle': ['Download this photo (largest size available)', 'এই ছবিটি ডাউনলোড করুন (সবচেয়ে বড় আকারে)'],
    'dl.videoTitleHd': ['Download this video (best quality)', 'এই ভিডিওটি ডাউনলোড করুন (সেরা মান)'],
    'dl.videoTitleSd': ['Download this video (smaller file)', 'এই ভিডিওটি ডাউনলোড করুন (ছোট ফাইল)'],
    'dl.savingPhoto': ['Saving the photo…', 'ছবি সেভ হচ্ছে…'],
    'dl.finding': ['Finding the video file…', 'ভিডিও ফাইল খোঁজা হচ্ছে…'],
    'dl.photoSavedRoot': ['Photo saved to your Downloads folder.', 'ছবিটি আপনার Downloads ফোল্ডারে সেভ হয়েছে।'],
    'dl.photoSaved': ['Photo saved to Downloads › Facebook.', 'ছবিটি Downloads › Facebook-এ সেভ হয়েছে।'],
    'dl.videoSaved': ['Video saved to Downloads › Facebook.', 'ভিডিওটি Downloads › Facebook-এ সেভ হয়েছে।'],
    'dl.videoSavedRoot': ['Video saved to your Downloads folder.', 'ভিডিওটি আপনার Downloads ফোল্ডারে সেভ হয়েছে।'],
    'dl.videoSavedQ': ['Video ({q}) saved to Downloads › Facebook.', 'ভিডিও ({q}) Downloads › Facebook-এ সেভ হয়েছে।'],
    'dl.reelSavedQ': ['Reel ({q}) saved to Downloads › Facebook.', 'রিল ({q}) Downloads › Facebook-এ সেভ হয়েছে।'],
    'dl.dashBoth': ['Facebook only offers this video as separate picture and sound files. Both were saved to Downloads › Facebook.', 'Facebook এই ভিডিওটি শুধু আলাদা ছবি আর শব্দের ফাইলে দেয়। দুটোই Downloads › Facebook-এ সেভ হয়েছে।'],
    'dl.noAnswerExt': ['The extension did not answer. Reload this tab and try again.', 'এক্সটেনশন সাড়া দেয়নি। এই ট্যাবটি রিলোড করে আবার চেষ্টা করুন।'],
    'dl.noStart': ['The download did not start.', 'ডাউনলোড শুরু হয়নি।'],
    'dl.photoUnreadable': ['This photo could not be read. Open it (click it) and try again.', 'ছবিটি পড়া গেল না। ছবিটি খুলে (ক্লিক করে) আবার চেষ্টা করুন।'],
    'dl.cannotSave': ['This picture cannot be saved.', 'এই ছবিটি সেভ করা যায় না।'],
    'dl.noAnswerPage': ['No answer from the page. Reload this tab and try again.', 'পেজ থেকে সাড়া মেলেনি। এই ট্যাবটি রিলোড করে আবার চেষ্টা করুন।'],
    'dl.noFile': ['Facebook did not give a file for this video. Open the video on its own page (click its date or time) and try again.', 'Facebook এই ভিডিওর কোনো ফাইল দেয়নি। ভিডিওটি নিজের পেজে খুলে (তারিখ বা সময়ে ক্লিক করে) আবার চেষ্টা করুন।'],
    'dl.nothingHere': ['No photo or video was found where you right-clicked.', 'যেখানে রাইট-ক্লিক করেছেন সেখানে কোনো ছবি বা ভিডিও পাওয়া যায়নি।'],
    'dl.onlyFb': ['Only photos and videos stored by Facebook can be downloaded.', 'শুধু Facebook-এ রাখা ছবি আর ভিডিও ডাউনলোড করা যায়।'],
    'dl.off': ['Downloads are turned off in Messenger Message Saver’s settings.', 'Messenger Message Saver-এর সেটিংসে ডাউনলোড বন্ধ আছে।'],
    'dl.chromeFailed': ['Chrome could not start the download: {error}', 'Chrome ডাউনলোড শুরু করতে পারেনি: {error}'],
    'menu.download': ['Download this photo or video', 'এই ছবি বা ভিডিও ডাউনলোড করুন'],

    /* ---------- desktop alerts ---------- */
    'notify.unsent': ['{who} unsent a message', '{who} একটি মেসেজ আনসেন্ড করেছেন'],
    'notify.edited': ['{who} edited a message', '{who} একটি মেসেজ এডিট করেছেন'],
    'notify.someone': ['Someone', 'কেউ একজন'],
    'notify.editBody': ['Before: "{before}"\nNow: "{now}"', 'আগে: "{before}"\nএখন: "{now}"'],
    'notify.lockedBody': ['Open Saved Messages to read it (PIN lock is on).', 'পড়তে সেভ করা মেসেজ খুলুন (পিন লক চালু আছে)।'],
    'unseen.backOn': ['Messenger Message Saver is back on. ', 'Messenger Message Saver আবার চালু হয়েছে। '],
    'unseen.on': ['Unseen mode is ON', 'Unseen মোড চালু'],
    'unseen.off': ['Unseen mode is OFF', 'Unseen মোড বন্ধ'],
    'unseen.onBody': ['People will not see "Seen" when you read.', 'আপনি পড়লেও অন্যরা "Seen" দেখবে না।'],
    'unseen.offBody': ['Messenger will show "Seen" again when you read.', 'আপনি পড়লে Messenger আবার "Seen" দেখাবে।'],
  };

  const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

  function resolve(pref, uiLang) {
    if (pref === 'bn' || pref === 'en') return pref;
    let ui = uiLang;
    if (ui === undefined) {
      try {
        ui = root.chrome && root.chrome.i18n && root.chrome.i18n.getUILanguage ? root.chrome.i18n.getUILanguage() : '';
      } catch (e) {
        ui = '';
      }
    }
    return /^bn\b/i.test(String(ui || '')) ? 'bn' : 'en';
  }

  function num(n, lang) {
    const s = String(n);
    return lang === 'bn' ? s.replace(/[0-9]/g, (d) => BN_DIGITS[d]) : s;
  }

  function locale(lang) {
    return lang === 'bn' ? 'bn-BD' : undefined;
  }

  function has(key) {
    return Object.prototype.hasOwnProperty.call(S, key);
  }

  function translate(lang, key, vars) {
    const entry = has(key) ? S[key] : null;
    let s = entry ? (lang === 'bn' && entry[1]) || entry[0] : String(key);
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, (m, k) => {
        if (!Object.prototype.hasOwnProperty.call(vars, k)) return m;
        const v = vars[k];
        return typeof v === 'number' ? num(v, lang) : String(v === undefined || v === null ? '' : v);
      });
    }
    return s;
  }

  /** Fills el with text that may contain <b>…</b> and <i>…</i> (built as elements, never parsed). */
  function rich(el, text) {
    const doc = el.ownerDocument;
    el.textContent = '';
    const stack = [el];
    for (const part of String(text).split(/(<\/?[bi]>)/)) {
      if (!part) continue;
      const open = /^<([bi])>$/.exec(part);
      const close = /^<\/([bi])>$/.exec(part);
      const top = stack[stack.length - 1];
      if (open) {
        const node = doc.createElement(open[1]);
        top.appendChild(node);
        stack.push(node);
      } else if (close) {
        if (stack.length > 1 && top.tagName.toLowerCase() === close[1]) stack.pop();
      } else {
        top.appendChild(doc.createTextNode(part.replace(/&amp;/g, '&')));
      }
    }
  }

  /** Translates a page: data-i18n (text), data-i18n-rich, data-i18n-title / -placeholder / -aria-label. */
  function apply(rootNode, lang) {
    for (const el of rootNode.querySelectorAll('[data-i18n]')) el.textContent = translate(lang, el.getAttribute('data-i18n'));
    for (const el of rootNode.querySelectorAll('[data-i18n-rich]')) rich(el, translate(lang, el.getAttribute('data-i18n-rich')));
    for (const [attr, name] of [
      ['data-i18n-title', 'title'],
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label'],
    ]) {
      for (const el of rootNode.querySelectorAll('[' + attr + ']')) el.setAttribute(name, translate(lang, el.getAttribute(attr)));
    }
    const doc = rootNode.ownerDocument || rootNode;
    if (doc && doc.documentElement) doc.documentElement.setAttribute('lang', lang === 'bn' ? 'bn' : 'en');
  }

  const api = { STRINGS: S, LANGS: ['en', 'bn'], resolve, translate, num, locale, apply, rich, has };
  root.MMS_I18N = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
