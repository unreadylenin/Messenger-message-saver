'use strict';
// Fictional demo chats for the Web Store screenshots (no real people or messages), in the
// extension's own backup format, so they load with db.importAll().

module.exports = function demoData(now = Date.now()) {
  const min = 60000;
  const at = (m) => now - m * min;
  const msg = (key, threadKey, senderName, text, minsAgo, extra = {}) => ({
    key,
    threadKey,
    senderName,
    text,
    ts: at(minsAgo),
    capturedAt: at(minsAgo),
    history: [],
    attachments: [],
    sources: ['screen'],
    ...extra,
  });
  const mine = (key, threadKey, text, minsAgo, extra = {}) => msg(key, threadKey, 'You', text, minsAgo, { isMine: true, ...extra });

  const messages = [
    msg('dm:demo-n1', 'demo-nadia', 'Nadia (demo)', 'Can you send me the notes from today’s class?', 96),
    mine('dm:demo-n2', 'demo-nadia', 'Sure, give me a minute', 95),
    msg('dm:demo-n3', 'demo-nadia', 'Nadia (demo)', 'Sorry, that last voice note was for my brother 🙈', 41, { unsent: true, unsentAt: at(39) }),
    msg('dm:demo-n4', 'demo-nadia', 'Nadia (demo)', 'Got the notes, thanks!', 35),
    msg('dm:demo-r1', 'demo-rafi', 'Rafi (demo)', 'কাল সকাল ১০টায় লাইব্রেরিতে দেখা হবে?', 74),
    mine('dm:demo-r2', 'demo-rafi', 'হ্যাঁ, আমি আসছি', 72),
    msg('dm:demo-r3', 'demo-rafi', 'Rafi (demo)', 'আমি একটু দেরি করব, ১৫ মিনিট', 22, { unsent: true, unsentAt: at(18) }),
    msg('dm:demo-g1', 'demo-group', 'Tanvir (demo)', 'Group meeting moved to 5 pm', 31, { edited: true, editedAt: at(26), history: [{ text: 'Group meeting moved to 4 pm', at: at(31) }] }),
    msg('dm:demo-g2', 'demo-group', 'Mim (demo)', 'I will bring the slides', 29),
    mine('dm:demo-g3', 'demo-group', 'Great, see you all there', 27),
    msg('dm:demo-g4', 'demo-group', 'Tanvir (demo)', 'Room 302 is free after 5', 12, { unsent: true, unsentAt: at(10) }),
    msg('dm:demo-a1', 'demo-ayon', 'Ayon (demo)', 'Happy birthday! 🎉', 300),
    mine('dm:demo-a2', 'demo-ayon', 'Thank you!! 😊', 290),
  ];
  const events = messages.filter((m) => m.unsent).map((m) => ({ type: 'unsent', messageKey: m.key, threadKey: m.threadKey, at: m.unsentAt, text: m.text, recovered: true }));
  return {
    format: 'messenger-message-saver',
    version: 2,
    messages,
    threads: [
      { threadKey: 'demo-nadia', domName: 'Nadia (demo)', updatedAt: at(35) },
      { threadKey: 'demo-rafi', domName: 'Rafi (demo)', updatedAt: at(18) },
      { threadKey: 'demo-group', domName: 'Study group (demo)', updatedAt: at(10) },
      { threadKey: 'demo-ayon', domName: 'Ayon (demo)', updatedAt: at(290) },
    ],
    contacts: [],
    notifications: [
      { title: 'Nadia (demo)', body: 'Sorry, that last voice note was for my brother 🙈', ts: at(41) },
      { title: 'Study group (demo)', body: 'Tanvir: Room 302 is free after 5', ts: at(12) },
    ],
    events,
    aliases: [],
    media: [],
  };
};
