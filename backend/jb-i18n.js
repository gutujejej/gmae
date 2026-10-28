// English is complete. Amharic covers the main screens (first draft, please review). Missing Amharic text falls back to English.
const en = {
  welcome: 'Welcome, <b>{name}</b>!\nComplete tasks, invite friends and earn <b>ETB</b> rewards.',
  captcha_emoji: 'Quick check: are you human?\nTap the <b>{name}</b> {emoji}',
  captcha_math: 'Quick check: are you human?\nWhat is <b>{q}</b> ?',
  captcha_wrong: 'Wrong answer. Try again.', captcha_new: 'Here is a new check.', captcha_fast: 'Too fast. Read the question first.',
  captcha_locked: 'Too many wrong answers. Try again in {min} minutes.', captcha_ok: 'Verified. Welcome aboard!',
  phone_ask: 'One more step: share your phone number with the button below.', phone_btn: 'Share my number',
  phone_prefix: 'Only numbers that start with {prefix} are accepted.', phone_used: 'This phone number is already registered.', phone_own: 'Please share your own number with the button.',
  menu: '<b>{name}</b>\n\nAvailable: <b>{balance} ETB</b>\nTotal earned: <b>{earned} ETB</b>\nFriends invited: <b>{refs}</b>',
  b_earn: 'Earn', b_wallet: 'Wallet', b_ref: 'Invite', b_daily: 'Daily check-in', b_withdraw: 'Withdraw', b_top: 'Top', b_app: 'Open app', b_help: 'Help', b_lang: 'Language', b_back: 'Back', b_verify: 'Verify', b_admin: 'Admin panel', b_cancel: 'Cancel', b_confirm: 'Confirm', b_all: 'Everything',
  earn_title: '<b>Tasks</b>\nJoin the channels, then press <b>Verify</b>.', earn_none: 'No tasks right now. Check again soon.',
  t_done: 'done', t_pending: 'in review', t_full: 'full', t_expired: 'expired', t_rejected: 'rejected',
  v_none: 'Nothing to verify right now.', v_ok: 'Verified! You earned <b>{amount} ETB</b>.', v_partial: 'Some tasks are not finished yet:\n{list}', v_cannot: 'I cannot check <b>{title}</b> right now. Please try again soon.', v_not: 'You have not joined <b>{title}</b> yet.',
  claim_ok: 'You earned <b>{amount} ETB</b>.', claim_review: 'Sent for review. You will be notified.', claim_dup: 'You already completed this task.', claim_full: 'This task is full.', claim_expired: 'This task has ended.', claim_unavail: 'This task is not available.', claim_daily_full: 'Today\'s limit is reached. Try tomorrow.', maint: 'This part is paused for maintenance. Please try later.', review_hold: 'Your account is under review. Support will contact you.', banned: 'Your account is suspended.', wait_visit: 'Please stay on the page a little longer, then press Verify again.', proof_ask: 'Send your proof (text or link) in one message.', proof_short: 'Please send a clearer proof.', visit_open: 'Open the page, wait {sec} seconds, then come back and press Verify.',
  wallet: '<b>Wallet</b>\n\nAvailable: <b>{balance} ETB</b>\nPending withdrawal: <b>{pending} ETB</b>\nLifetime earnings: <b>{earned} ETB</b>\nFrom tasks: {task} ETB\nFrom referrals: {ref} ETB\nWithdrawn: {withdrawn} ETB\n\n<i>Rewards are promotional credits. A withdrawal is only paid after the admin confirms it.</i>',
  ref: '<b>Invite friends</b>\n\nYour link:\n{link}\n\nQualified friends: <b>{ok}</b>\nWaiting: <b>{wait}</b>\nEarned: <b>{earned} ETB</b>\n\nYou get <b>{reward} ETB</b> when a friend {cond}.', ref_cond_captcha: 'passes the check', ref_cond_tasks: 'completes {n} task(s)', ref_off: 'Referrals are switched off.', b_share: 'Share link',
  top: '<b>Leaderboard</b>', top_none: 'No data yet.', b_by_earn: 'Earnings', b_by_tasks: 'Tasks', b_by_ref: 'Referrals',
  wd_min: 'Minimum withdrawal is <b>{min} ETB</b>. Your available balance is {balance} ETB.', wd_method: 'Choose a withdrawal method:', wd_account: 'Send your <b>{method}</b> account or phone number.', wd_bad_account: 'That does not look right. Send it again.', wd_amount: 'How much? Between <b>{min}</b> and <b>{max} ETB</b>.', wd_bad_amount: 'Enter a valid amount between {min} and {max} ETB.',
  wd_confirm: '<b>Confirm withdrawal</b>\n\nAmount: {amount} ETB\nFee: {fee} ETB\nYou receive: <b>{net} ETB</b>\nMethod: {method}\nAccount: {account}', wd_sent: 'Request #{id} sent. The amount is reserved until the admin decides.',
  wd_err_pending_exists: 'You already have a withdrawal in progress.', wd_err_low_balance: 'Not enough balance.', wd_err_below_min: 'Below the minimum withdrawal.', wd_err_above_max: 'Above the maximum withdrawal.', wd_err_under_review: 'Your account is under review.', wd_err_fee_too_high: 'The fee is higher than the amount.', wd_err_no_user: 'Account not available.',
  wd_s_approved: 'Withdrawal #{id} was approved and is waiting for payment.', wd_s_processing: 'Withdrawal #{id} is being processed.', wd_s_paid: 'Withdrawal #{id} was paid: {net} ETB. Reference: {ref}', wd_s_rejected: 'Withdrawal #{id} was rejected. {amount} ETB is back in your balance. {note}',
  help: '<b>Help</b>\n\n1. Do tasks in <b>Earn</b>.\n2. Invite friends.\n3. Withdraw when you reach the minimum.', b_support: 'Contact support', support_ask: 'Write your message for support in one message.', support_sent: 'Message sent. We will reply here.', support_reply: 'Support reply:\n{text}',
  lang_pick: 'Choose your language:', cancelled: 'Cancelled.', ref_ok_note: 'Your friend {name} qualified. You earned <b>{amount} ETB</b>.', reversed: 'Reward of {amount} ETB for <b>{title}</b> was reversed because you left the channel. Rule: {rules}',
  adm_wd: '<b>New withdrawal #{id}</b>\nUser: {user}\nAmount: {amount} ETB (net {net})\n{method}: {account}', adm_ticket: '<b>Support ticket</b> from {user}\n{text}', b_approve: 'Approve', b_reject: 'Reject',
};
const am = {
  welcome: 'እንኳን ደህና መጡ, <b>{name}</b>!\nተግባራትን ያጠናቅቁ፣ ጓደኞችን ይጋብዙ እና <b>ብር</b> ያግኙ።',
  captcha_emoji: 'ፈጣን ፍተሻ: ሰው ነዎት?\n<b>{name}</b> {emoji} ን ይጫኑ', captcha_math: 'ፈጣን ፍተሻ: ሰው ነዎት?\n<b>{q}</b> ስንት ነው?', captcha_wrong: 'ስህተት ነው። እንደገና ይሞክሩ።', captcha_ok: 'ተረጋግጧል። እንኳን ደህና መጡ!',
  b_earn: 'ሥራዎች', b_wallet: 'ቦርሳ', b_ref: 'ጋብዝ', b_daily: 'ዕለታዊ ሽልማት', b_withdraw: 'ገንዘብ አውጣ', b_top: 'ምርጦች', b_app: 'መተግበሪያ ክፈት', b_help: 'እገዛ', b_lang: 'ቋንቋ', b_back: 'ተመለስ', b_verify: 'አረጋግጥ', b_cancel: 'ሰርዝ', b_confirm: 'አረጋግጥ',
  earn_title: '<b>ሥራዎች</b>\nቻናሎችን ይቀላቀሉ፣ ከዚያ <b>አረጋግጥ</b> ይጫኑ።', earn_none: 'አሁን ምንም ሥራ የለም።',
  v_ok: 'ተረጋግጧል! <b>{amount} ብር</b> አግኝተዋል።', claim_ok: '<b>{amount} ብር</b> አግኝተዋል።', claim_dup: 'ይህን ሥራ አስቀድመው ጨርሰዋል።',
  menu: '<b>{name}</b>\n\nቀሪ ሂሳብ: <b>{balance} ብር</b>\nጠቅላላ ገቢ: <b>{earned} ብር</b>\nየተጋበዙ ጓደኞች: <b>{refs}</b>', help: '<b>እገዛ</b>\n\n1. በ <b>ሥራዎች</b> ውስጥ ተግባራትን ይሥሩ።\n2. ጓደኞችን ይጋብዙ።\n3. ዝቅተኛው መጠን ሲደርስ ገንዘብ ያውጡ።', cancelled: 'ተሰርዟል።',
  captcha_new: 'አዲስ ፍተሻ ይኸውና።', captcha_fast: 'በጣም ፈጣን ነው። መጀመሪያ ጥያቄውን ያንብቡ።', captcha_locked: 'ብዙ የተሳሳቱ መልሶች። ከ{min} ደቂቃ በኋላ እንደገና ይሞክሩ።',
  phone_ask: 'አንድ ተጨማሪ ደረጃ፦ ከታች ባለው አዝራር የስልክ ቁጥርዎን ያጋሩ።', phone_btn: 'ቁጥሬን አጋራ', phone_prefix: 'በ{prefix} የሚጀምሩ ቁጥሮች ብቻ ተቀባይነት አላቸው።',
  phone_used: 'ይህ የስልክ ቁጥር አስቀድሞ ተመዝግቧል።', phone_own: 'እባክዎ የራስዎን ቁጥር በአዝራሩ ያጋሩ።',
  b_admin: 'የአስተዳዳሪ ፓነል', b_all: 'ሁሉም', t_done: 'ተጠናቋል', t_pending: 'በግምገማ ላይ', t_full: 'ሞልቷል', t_expired: 'አብቅቷል', t_rejected: 'ውድቅ ተደርጓል',
  v_none: 'አሁን የሚረጋገጥ ነገር የለም።', v_partial: 'አንዳንድ ተግባራት ገና አልተጠናቀቁም፦\n{list}', v_cannot: '<b>{title}</b> ን አሁን ማረጋገጥ አልቻልኩም። እባክዎ በቅርቡ እንደገና ይሞክሩ።', v_not: '<b>{title}</b> ን እስካሁን አልተቀላቀሉም።',
  claim_review: 'ለግምገማ ተልኳል። ውጤቱ ይነገርዎታል።', claim_full: 'ይህ ተግባር ሞልቷል።', claim_expired: 'ይህ ተግባር አብቅቷል።', claim_unavail: 'ይህ ተግባር አይገኝም።', claim_daily_full: 'የዛሬው ገደብ ደርሷል። ነገ ይሞክሩ።',
  maint: 'ይህ ክፍል ለጥገና ቆሟል። እባክዎ በኋላ ይሞክሩ።', review_hold: 'አካውንትዎ በግምገማ ላይ ነው። ድጋፍ ሰጪዎች ያነጋግርዎታል።', banned: 'አካውንትዎ ታግዷል።',
  wait_visit: 'እባክዎ በገጹ ላይ ትንሽ ተጨማሪ ይቆዩ፣ ከዚያ «አረጋግጥ» ን እንደገና ይጫኑ።', proof_ask: 'ማረጋገጫዎን (ጽሑፍ ወይም አገናኝ) በአንድ መልዕክት ይላኩ።', proof_short: 'እባክዎ ይበልጥ ግልጽ ማረጋገጫ ይላኩ።',
  visit_open: 'ገጹን ይክፈቱ፣ {sec} ሰከንድ ይጠብቁ፣ ከዚያ ተመልሰው «አረጋግጥ» ን ይጫኑ።',
  wallet: '<b>ቦርሳ</b>\n\nሊወጣ የሚችል፦ <b>{balance} ብር</b>\nበመጠባበቅ ላይ ያለ ገንዘብ ማውጣት፦ <b>{pending} ብር</b>\nጠቅላላ ገቢ፦ <b>{earned} ብር</b>\nከተግባራት፦ {task} ብር\nከግብዣዎች፦ {ref} ብር\nየወጣ፦ {withdrawn} ብር\n\n<i>ሽልማቶች የማስተዋወቂያ ክሬዲቶች ናቸው። ገንዘብ ማውጣት የሚከፈለው አስተዳዳሪው ካረጋገጠ በኋላ ብቻ ነው።</i>',
  ref: '<b>ጓደኞችን ይጋብዙ</b>\n\nየእርስዎ አገናኝ፦\n{link}\n\nብቁ የሆኑ ጓደኞች፦ <b>{ok}</b>\nበመጠባበቅ ላይ፦ <b>{wait}</b>\nየተገኘ፦ <b>{earned} ብር</b>\n\nጓደኛዎ {cond} <b>{reward} ብር</b> ያገኛሉ።',
  ref_cond_captcha: 'ማረጋገጫውን ሲያልፍ', ref_cond_tasks: '{n} ተግባር(ራት) ሲያጠናቅቅ', ref_off: 'ግብዣዎች ጠፍተዋል።', b_share: 'አገናኙን አጋራ',
  top: '<b>የደረጃ ሰንጠረዥ</b>', top_none: 'እስካሁን መረጃ የለም።', b_by_earn: 'በገቢ', b_by_tasks: 'በተግባራት', b_by_ref: 'በግብዣዎች',
  wd_min: 'ዝቅተኛው የገንዘብ ማውጣት መጠን <b>{min} ብር</b> ነው። ሊወጣ የሚችል ቀሪ ሂሳብዎ {balance} ብር ነው።', wd_method: 'የገንዘብ ማውጫ ዘዴ ይምረጡ፦',
  wd_account: 'የ<b>{method}</b> ሂሳብዎን ወይም የስልክ ቁጥርዎን ይላኩ።', wd_bad_account: 'ይህ ትክክል አይመስልም። እንደገና ይላኩ።',
  wd_amount: 'ምን ያህል? ከ<b>{min}</b> እስከ <b>{max} ብር</b> መካከል።', wd_bad_amount: 'ከ{min} እስከ {max} ብር መካከል ትክክለኛ መጠን ያስገቡ።',
  wd_confirm: '<b>ገንዘብ ማውጣቱን ያረጋግጡ</b>\n\nመጠን፦ {amount} ብር\nክፍያ፦ {fee} ብር\nየሚደርስዎት፦ <b>{net} ብር</b>\nዘዴ፦ {method}\nሂሳብ፦ {account}',
  wd_sent: 'ጥያቄ #{id} ተልኳል። አስተዳዳሪው እስኪወስን ድረስ መጠኑ ተይዞ ይቆያል።',
  wd_err_pending_exists: 'አስቀድመው በሂደት ላይ ያለ ገንዘብ ማውጣት አለዎት።', wd_err_low_balance: 'ቀሪ ሂሳብዎ በቂ አይደለም።', wd_err_below_min: 'ከዝቅተኛው የገንዘብ ማውጣት መጠን በታች ነው።',
  wd_err_above_max: 'ከከፍተኛው የገንዘብ ማውጣት መጠን በላይ ነው።', wd_err_under_review: 'አካውንትዎ በግምገማ ላይ ነው።', wd_err_fee_too_high: 'ክፍያው ከመጠኑ ይበልጣል።', wd_err_no_user: 'አካውንቱ አይገኝም።',
  wd_s_approved: 'ገንዘብ ማውጣት #{id} ጸድቋል፣ ክፍያውን እየጠበቀ ነው።', wd_s_processing: 'ገንዘብ ማውጣት #{id} በሂደት ላይ ነው።', wd_s_paid: 'ገንዘብ ማውጣት #{id} ተከፍሏል፦ {net} ብር። ማጣቀሻ፦ {ref}',
  wd_s_rejected: 'ገንዘብ ማውጣት #{id} ውድቅ ተደርጓል። {amount} ብር ወደ ቀሪ ሂሳብዎ ተመልሷል። {note}',
  b_support: 'ድጋፍ ያግኙ', support_ask: 'ለድጋፍ መልዕክትዎን በአንድ መልዕክት ይጻፉ።', support_sent: 'መልዕክት ተልኳል። እዚሁ እንመልስልዎታለን።', support_reply: 'የድጋፍ መልስ፦\n{text}',
  lang_pick: 'ቋንቋዎን ይምረጡ፦', ref_ok_note: 'ጓደኛዎ {name} ብቁ ሆኗል። <b>{amount} ብር</b> አግኝተዋል።',
  reversed: 'ቻናሉን ስለለቀቁ ለ<b>{title}</b> የተሰጠዎት {amount} ብር ሽልማት ተመልሷል። ደንብ፦ {rules}',
  adm_wd: '<b>አዲስ ገንዘብ ማውጣት #{id}</b>\nተጠቃሚ፦ {user}\nመጠን፦ {amount} ብር (የተጣራ {net})\n{method}፦ {account}', adm_ticket: '<b>የድጋፍ ጥያቄ</b> ከ{user}\n{text}', b_approve: 'ፍቀድ', b_reject: 'ውድቅ አድርግ',
};
const DICT = { en, am };
const makeT = (lang) => (key, vars = {}) => {
  let s = (DICT[lang] && DICT[lang][key]) || en[key] || key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
};
module.exports = { makeT };
module.exports.DICT = DICT;
