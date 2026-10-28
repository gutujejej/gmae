/* Amharic for the Join & Earn mini app (users, admins and controller).
   It translates the screen text on the fly, so the English app code stays untouched.
   Missing phrases simply stay in English. The EN / አማ button in the header switches language and remembers the choice.
   Placeholders: {} = any text, {n} = a number. {1} {2} in a translation put captured pieces in a different order. */
(function () {
  'use strict';

  var D = {
    /* ---------- navigation and headings ---------- */
    "Home": "መነሻ", "Earn": "ያግኙ", "Invite": "ይጋብዙ", "Wallet": "ቦርሳ", "Profile": "መገለጫ", "More": "ተጨማሪ",
    "Overview": "አጠቃላይ", "Money": "ገንዘብ", "Tasks": "ተግባራት", "Content": "ይዘት",
    "Users": "ተጠቃሚዎች", "Support": "ድጋፍ", "Alerts": "ማንቂያዎች", "Audit log": "የድርጊት መዝገብ", "Reports": "ሪፖርቶች",
    "Settings": "ቅንብሮች", "Channels": "ቻናሎች", "Messages": "መልዕክቶች", "Posts": "ልጥፎች", "Broadcast": "ማሰራጫ",
    "Campaigns": "ዘመቻዎች", "Banners": "ማስታወቂያዎች", "Notifications": "ማሳወቂያዎች", "Language": "ቋንቋ", "History": "ታሪክ",
    "Switches": "መቀየሪያዎች", "Verification": "ማረጋገጫ", "Referrals": "ግብዣዎች", "Withdrawals": "ገንዘብ ማውጣቶች",
    "Membership rules": "የአባልነት ደንቦች", "Fake accounts": "ሐሰተኛ አካውንቶች", "Leaderboard": "የደረጃ ሰንጠረዥ",
    "Welcome": "እንኳን ደህና መጡ", "Admin": "አስተዳዳሪ", "Admins": "አስተዳዳሪዎች", "User": "ተጠቃሚ",
    "Controller": "ተቆጣጣሪ", "Platform owner": "የመድረኩ ባለቤት", "Bot": "ቦት", "Bot name": "የቦት ስም",
    "Admin · {}": "አስተዳዳሪ · {}", "Chat #{}": "ቻት #{}",

    /* ---------- common buttons and words ---------- */
    "Save": "አስቀምጥ", "Saved": "ተቀምጧል", "Settings saved": "ቅንብሮች ተቀምጠዋል", "Save settings": "ቅንብሮችን አስቀምጥ",
    "Cancel": "ሰርዝ", "Confirm": "አረጋግጥ", "Close": "ዝጋ", "Back": "ተመለስ", "Edit": "አስተካክል", "Remove": "አስወግድ",
    "Removed": "ተወግዷል", "Create": "ፍጠር", "Send": "ላክ", "Sent": "ተልኳል", "Apply": "ተግብር", "Next": "ቀጣይ",
    "Previous": "ቀዳሚ", "Go": "ሂድ", "Copy": "ቅዳ", "Share": "አጋራ", "Copied": "ተቀድቷል", "Press and hold to copy": "ለመቅዳት ተጭነው ይያዙ",
    "Show all": "ሁሉንም አሳይ", "Search id or name": "መታወቂያ ወይም ስም ፈልግ", "None": "ምንም", "All": "ሁሉም", "Off": "ጠፍቷል",
    "Closed": "ተዘግቷል", "Connected": "ተገናኝቷል", "Earnings": "ገቢ", "End": "መጨረሻ", "Rewards": "ሽልማቶች", "Task": "ተግባር", "Updated": "ተዘምኗል", "Withdraw": "ገንዘብ አውጣ", "User {}": "ተጠቃሚ {}", "Name": "ስም", "Message": "መልዕክት", "Title": "ርዕስ", "Text": "ጽሑፍ", "Type": "አይነት", "Status": "ሁኔታ", "Role": "ሚና", "Method": "ዘዴ",
    "Fee": "ክፍያ", "Max": "ከፍተኛ", "Description": "መግለጫ", "Media": "ሚዲያ", "Photo": "ፎቶ", "Video": "ቪዲዮ",
    "Review": "ገምግም", "Reply": "መልስ", "Retry": "እንደገና ሞክር", "Pause": "አቁም", "Resume": "ቀጥል", "Publish": "አትም",
    "Published": "ታትሟል", "Scheduled": "ተይዟል", "Schedule": "መርሐግብር አስይዝ", "Failed": "አልተሳካም", "Cancelled": "ተሰርዟል",
    "Archive": "ወደ ማህደር አስገባ", "Archived": "ማህደር ገብቷል", "Activate": "አንቃ", "Reactivate": "እንደገና አንቃ",
    "Suspend": "አግድ", "Suspended": "ታግዷል", "Dismiss": "ዝጋ", "Approve": "ፍቀድ", "Approved": "ጸድቋል",
    "Reject": "ውድቅ አድርግ", "Rejected": "ውድቅ ተደርጓል", "Pending": "በመጠባበቅ ላይ", "Waiting": "በመጠባበቅ ላይ",
    "Paid": "ተከፍሏል", "Processing": "በሂደት ላይ", "Handled": "ተስተናግዷል", "Open": "ክፈት", "Done": "ተጠናቋል",
    "In review": "በግምገማ ላይ", "Full": "ሞልቷል", "Ended": "አብቅቷል", "Ends": "ያበቃል", "Starts": "ይጀምራል", "Expires": "ያበቃል",
    "Qualified": "ብቁ የሆኑ", "Earned": "የተገኘ", "Lifetime": "ጠቅላላ", "Withdrawn": "የወጣ", "Available": "ያለ",
    "Verified": "የተረጋገጡ", "Not verified": "አልተረጋገጠም", "Verify": "አረጋግጥ", "Connect": "አገናኝ", "Active": "ንቁ",
    "Once": "አንድ ጊዜ", "Every day": "በየቀኑ", "Every week": "በየሳምንቱ", "Repeat": "ድገም", "Pinned": "ተሰክቷል",
    "Easy": "ቀላል", "Normal": "መካከለኛ", "Hard": "ከባድ", "Daily": "ዕለታዊ", "English": "English",
    "ETB": "ብር", "{n} ETB": "{n} ብር", "{n} ETB · {}": "{n} ብር · {}", "Fee {n}": "ክፍያ {n}", "You get {n}": "ያገኛሉ {n}",
    "Ref {}": "ማጣቀሻ {}", "ID {}": "መታወቂያ {}", "now": "አሁን", "{n}m": "ከ{n} ደቂቃ በፊት", "{n}h": "ከ{n} ሰዓት በፊት", "{n}d": "ከ{n} ቀን በፊት",
    "joined {}": "ተቀላቅሏል፦ {}", "{n} joined": "{n} ተቀላቅለዋል", "{n}/{n} joined": "{1}/{2} ተቀላቅለዋል", "ends {}": "ያበቃል፦ {}",
    "Failed to fetch": "ከሰርቨሩ ጋር መገናኘት አልተቻለም። ኢንተርኔትዎን ያረጋግጡ።",
    "Something went wrong.": "የሆነ ችግር ተፈጥሯል።", "Something went wrong. Please try again.": "የሆነ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።",

    /* lowercase words the app prints for statuses, task types and roles */
    "open": "ክፍት", "closed": "ተዘግቷል", "active": "ንቁ", "paused": "ቆሟል", "pending": "በመጠባበቅ ላይ", "approved": "ጸድቋል",
    "rejected": "ውድቅ ተደርጓል", "paid": "ተከፍሏል", "processing": "በሂደት ላይ", "qualified": "ብቁ ሆኗል", "scheduled": "ተይዟል",
    "done": "ተጠናቋል", "error": "ስህተት", "queued": "ተሰልፏል", "running": "በሂደት ላይ", "cancelled": "ተሰርዟል",
    "join": "መቀላቀል", "daily": "ዕለታዊ", "visit": "ገጽ መጎብኘት", "custom": "ብጁ", "none yet": "እስካሁን የለም",
    "owner": "ባለቤት", "admin": "አስተዳዳሪ", "finance": "ፋይናንስ", "moderator": "ሞደሬተር", "support": "ድጋፍ",
    "suspended": "ታግዷል", "review": "በግምገማ", "no check": "ያልተረጋገጠ", "not verified": "አልተረጋገጠም",
    "held for review": "ለግምገማ ተይዟል", "alert only": "ማንቂያ ብቻ",

    /* ---------- user home, earn, invite, wallet ---------- */
    "Available balance": "ሊወጣ የሚችል ቀሪ ሂሳብ", "Verify you are human": "ሰው መሆንዎን ያረጋግጡ",
    "Open the bot and send /start to finish the quick check. Rewards unlock after it.": "ቦቱን ከፍተው /start ይላኩ እና ፈጣኑን ማረጋገጫ ያጠናቅቁ። ሽልማቶች ከዚያ በኋላ ይከፈታሉ።",
    "Your account is under review. Support will contact you.": "አካውንትዎ በግምገማ ላይ ነው። ድጋፍ ሰጪዎች ያነጋግርዎታል።",
    "Your account is under review.": "አካውንትዎ በግምገማ ላይ ነው።",
    "Some features are paused for maintenance.": "አንዳንድ አገልግሎቶች ለጥገና ቆመዋል።",
    "Friends": "ጓደኞች", "Tasks done": "የተጠናቀቁ ተግባራት", "From tasks": "ከተግባራት", "From referrals": "ከግብዣዎች",
    "Available tasks": "ያሉ ተግባራት", "See all tasks": "ሁሉንም ተግባራት እይ", "Recent activity": "የቅርብ ጊዜ እንቅስቃሴ",
    "Verify all channels": "ሁሉንም ቻናሎች አረጋግጥ", "Nothing to choose yet.": "እስካሁን የሚመረጥ የለም።",
    "No new tasks right now. Check again soon.": "አሁን አዲስ ተግባር የለም። በቅርቡ ደግመው ይመልከቱ።",
    "Your rewards will appear here.": "ሽልማቶችዎ እዚህ ይታያሉ።", "No tasks in this list.": "በዚህ ዝርዝር ውስጥ ተግባር የለም።",
    "Claim reward": "ሽልማት ውሰድ", "Open page": "ገጹን ክፈት", "Submit proof": "ማረጋገጫ ላክ", "Submit": "ላክ",
    "Stay on the page a few seconds, then press Verify.": "በገጹ ላይ ጥቂት ሰከንዶች ይቆዩ እና «አረጋግጥ» ይጫኑ።",
    "Not finished yet": "ገና አልተጠናቀቀም", "Nothing new to verify.": "ለማረጋገጥ አዲስ ነገር የለም።",
    "Paste your proof or a link": "ማረጋገጫዎን ወይም አገናኝ ይለጥፉ", "Transaction id": "የግብይት መታወቂያ",
    "{n}% on every task.": "{n}% ተጨማሪ በእያንዳንዱ ተግባር።", "Ends {}.": "ያበቃል፦ {}።",
    "We re-check channel membership for {} days{}": "የቻናል አባልነትዎን ለ{} ቀናት እንደገና እንፈትሻለን{}",
    ". If you leave, the reward is reversed and you are notified.": "። ከወጡ ሽልማቱ ይመለሳል እና ይነገርዎታል።",
    "Invite friends and earn": "ጓደኞችን ጋብዘው ገቢ ያግኙ", "ETB per friend": "ብር በአንድ ጓደኛ", "ETB per referral": "ብር በአንድ ግብዣ",
    "Your link": "የእርስዎ አገናኝ", "Earn ETB rewards with me!": "ከእኔ ጋር የብር ሽልማቶችን ያግኙ!",
    "You get paid when a friend {}. Self-referrals and fake accounts are not rewarded.": "ጓደኛዎ {} ይከፈልዎታል። ራስን መጋበዝ እና ሐሰተኛ አካውንቶች አይሸለሙም።",
    "passes the quick check": "ፈጣኑን ማረጋገጫ ሲያልፍ", "joins": "ሲቀላቀል", "completes {n} task(s)": "{n} ተግባር(ራት) ሲያጠናቅቅ",
    "passes the quick check and completes {n} task(s)": "ፈጣኑን ማረጋገጫ አልፎ {n} ተግባር(ራት) ሲያጠናቅቅ",
    "Referrals are switched off.": "ግብዣዎች ጠፍተዋል።", "Referrals ({})": "ግብዣዎች ({})",
    "No data yet.": "እስካሁን መረጃ የለም።", "Pending withdrawal": "በመጠባበቅ ላይ ያለ ገንዘብ ማውጣት",
    "Rewards are promotional credits. A withdrawal is paid only after the admin confirms it. Minimum:": "ሽልማቶች የማስተዋወቂያ ክሬዲቶች ናቸው። ገንዘብ ማውጣት የሚከፈለው አስተዳዳሪው ካረጋገጠ በኋላ ብቻ ነው። ዝቅተኛው፦",
    "Withdrawals are paused for maintenance.": "ገንዘብ ማውጣት ለጥገና ቆሟል።", "You already have a request in progress.": "አስቀድመው በሂደት ላይ ያለ ጥያቄ አለዎት።",
    "Account or phone number": "የሂሳብ ወይም የስልክ ቁጥር", "Amount (ETB)": "መጠን (ብር)", "Request withdrawal": "ገንዘብ ማውጣት ጠይቅ",
    "Fee {n} ETB · you receive {n} ETB": "ክፍያ {1} ብር · የሚደርስዎት {2} ብር", "ETB · you receive {n} ETB": "ብር · የሚደርስዎት {n} ብር",
    "Request sent": "ጥያቄ ተልኳል", "No withdrawals yet.": "እስካሁን ገንዘብ ማውጣት የለም።", "No transactions yet.": "እስካሁን ግብይት የለም።",
    "Task reward": "የተግባር ሽልማት", "Daily reward": "የዕለት ሽልማት", "Referral reward": "የግብዣ ሽልማት", "Withdrawal refund": "የገንዘብ ማውጣት ተመላሽ",
    "Reward reversed": "ሽልማት ተመልሷል", "Adjustment": "ማስተካከያ", "Withdrawal": "ገንዘብ ማውጣት",
    "Do tasks in Earn, invite friends, and withdraw when you reach the minimum.": "በ«ያግኙ» ውስጥ ተግባራትን ይስሩ፣ ጓደኞችን ይጋብዙ እና ዝቅተኛውን ሲደርሱ ገንዘብ ያውጡ።",
    "Help and support": "እገዛ እና ድጋፍ", "Send to support": "ወደ ድጋፍ ላክ", "Sent to support": "ወደ ድጋፍ ተልኳል",
    "Write your question for support": "ጥያቄዎን ለድጋፍ ይጻፉ", "Where should we send it?": "ወዴት ይላክ?",
    "Support:": "ድጋፍ፦", "You:": "እርስዎ፦", "Tickets from users": "ከተጠቃሚዎች የመጡ ጥያቄዎች", "No tickets.": "ጥያቄ የለም።",
    "Your reply goes to the user in the bot": "መልስዎ በቦቱ ውስጥ ለተጠቃሚው ይላካል",

    /* ---------- admin: overview, alerts ---------- */
    "Active (7d)": "ንቁ (7 ቀን)", "Task completions": "የተጠናቀቁ ተግባራት", "Rewards credited": "የተሰጡ ሽልማቶች",
    "Referral earnings": "የግብዣ ገቢ", "Owed to users": "ለተጠቃሚዎች ያለበት ዕዳ", "balances + pending": "ቀሪ ሂሳብ + በመጠባበቅ ላይ",
    "Paid out": "የተከፈለ", "Last 14 days": "ያለፉት 14 ቀናት", "new users": "አዲስ ተጠቃሚዎች", "task completions": "የተጠናቀቁ ተግባራት",
    "{n} new today": "{n} ዛሬ አዲስ", "{n} blocked the bot": "{n} ቦቱን አግደዋል", "(net {})": "(የተጣራ {})",
    "{n} withdrawal(s) waiting": "{n} የገንዘብ ማውጣት ጥያቄ(ዎች) እየጠበቁ ነው", "{n} ETB. Tap to review.": "{n} ብር። ለመገምገም ይንኩ።",
    "{n} task proof(s) to review": "{n} የተግባር ማረጋገጫ(ዎች) ለግምገማ", "{n} suspicious activity alert(s)": "{n} አጠራጣሪ እንቅስቃሴ ማንቂያ(ዎች)",
    "Search, suspend, adjust, review": "ፈልግ፣ አግድ፣ አስተካክል፣ ገምግም", "Suspicious activity": "አጠራጣሪ እንቅስቃሴ",
    "Every admin action": "እያንዳንዱ የአስተዳዳሪ ድርጊት", "Download CSV files": "የCSV ፋይሎችን አውርድ",
    "Rewards, withdrawals, captcha, messages": "ሽልማቶች፣ ገንዘብ ማውጣት፣ ማረጋገጫ፣ መልዕክቶች", "Roles and permissions": "ሚናዎች እና ፈቃዶች",
    "No open alerts.": "ክፍት ማንቂያ የለም።", "Nothing here.": "እዚህ ምንም የለም።", "Task proofs": "የተግባር ማረጋገጫዎች", "No proofs waiting.": "የሚጠብቅ ማረጋገጫ የለም።",
    "multi_account": "ብዙ አካውንቶች በአንድ ስልክ", "same_device_guess": "ተመሳሳይ ስልክ ሊሆን ይችላል", "duplicate_phone": "የተደጋገመ ስልክ ቁጥር",
    "referral_burst": "ድንገተኛ የግብዣ መብዛት", "captcha_fails": "ብዙ የማረጋገጫ ስህተቶች", "rapid_claims": "ፈጣን ተከታታይ ሽልማት መውሰድ", "left_channel": "ቻናሉን ለቋል",
    "Same phone as user {n}. Action: {}.": "ከተጠቃሚ {1} ጋር አንድ ስልክ። እርምጃ፦ {2}።",
    "Looks like the phone of user {} (same model and network). Check before acting.": "የተጠቃሚ {} ስልክ ሊሆን ይችላል (ተመሳሳይ ሞዴል እና ኔትወርክ)። እርምጃ ከመውሰድዎ በፊት ያረጋግጡ።",
    "{n} referrals in one hour": "{n} ግብዣዎች በአንድ ሰዓት ውስጥ", "{n} wrong answers": "{n} የተሳሳቱ መልሶች", "{n} claims in one hour": "{n} ሽልማቶች በአንድ ሰዓት ውስጥ ተወስደዋል",

    /* ---------- admin: money ---------- */
    "Mark as paid": "እንደተከፈለ ምልክት አድርግ", "Mark paid": "ተከፍሏል በል", "Marked paid": "ተከፍሏል ተብሎ ተመዝግቧል",
    "Reject withdrawal": "ማውጣቱን ውድቅ አድርግ", "Reject and refund": "ውድቅ አድርግ እና መልስ", "Rejected and refunded": "ውድቅ ተደርጓል እና ተመልሷል",
    "Payment reference": "የክፍያ ማጣቀሻ", "Only mark paid after the money was really sent.": "ገንዘቡ በእርግጥ ከተላከ በኋላ ብቻ «ተከፍሏል» ብለው ምልክት ያድርጉ።",
    "Reason (the user sees it)": "ምክንያት (ተጠቃሚው ያየዋል)", "Why?": "ለምን?",

    /* ---------- admin: tasks, channels, campaigns ---------- */
    "New task": "አዲስ ተግባር", "Edit task": "ተግባር አስተካክል", "No tasks yet. Create your first one.": "እስካሁን ተግባር የለም። የመጀመሪያውን ይፍጠሩ።",
    "Join a channel or group": "ቻናል ወይም ግሩፕ ይቀላቀሉ", "Daily check-in": "ዕለታዊ ተመዝግቦ መግባት", "Visit a page": "ገጽ ይጎብኙ",
    "Custom (admin approves proof)": "ብጁ (አስተዳዳሪው ማረጋገጫውን ያጸድቃል)", "Reward (ETB)": "ሽልማት (ብር)",
    "Channel or group": "ቻናል ወይም ግሩፕ", "Page link (https)": "የገጽ አገናኝ (https)", "Seconds the user must wait": "ተጠቃሚው መጠበቅ ያለበት ሰከንዶች",
    "Instructions link (optional)": "የመመሪያ አገናኝ (አማራጭ)", "Max participants": "ከፍተኛ ተሳታፊዎች", "Empty = unlimited": "ባዶ = ገደብ የለም",
    "Max completions per day (all users)": "በቀን ከፍተኛ ማጠናቀቂያ (ሁሉም ተጠቃሚዎች)", "Order (small first)": "ቅደም ተከተል (ትንሹ መጀመሪያ)",
    "Archive this task?": "ይህ ተግባር ወደ ማህደር ይግባ?", "Users will no longer see it. Past rewards stay.": "ተጠቃሚዎች ከዚህ በኋላ አያዩትም። ያለፉ ሽልማቶች ይቀራሉ።",
    "Remove this channel?": "ይህ ቻናል ይወገድ?", "Tasks that use it keep working until you archive them.": "የሚጠቀሙት ተግባራት ማህደር እስክታስገቡ ድረስ መስራታቸውን ይቀጥላሉ።",
    "Connect a channel or group": "ቻናል ወይም ግሩፕ አገናኝ", "Add the bot as an admin first. Then enter the @username (or a numeric id for private chats).": "መጀመሪያ ቦቱን አስተዳዳሪ አድርገው ያክሉት። ከዚያ @username (ለግል ቻቶች የቁጥር መታወቂያ) ያስገቡ።",
    "No channels connected.": "ምንም ቻናል አልተገናኘም።", "Last error: {}": "የመጨረሻ ስህተት፦ {}",
    "New campaign": "አዲስ ዘመቻ", "No active campaigns.": "ንቁ ዘመቻ የለም።", "Task bonus (%)": "የተግባር ጉርሻ (%)", "Extra ETB per referral": "በእያንዳንዱ ግብዣ ተጨማሪ ብር",
    "Campaign created": "ዘመቻ ተፈጥሯል", "{n}% tasks": "{n}% ጉርሻ በተግባራት",

    /* ---------- admin: posts, broadcasts, announcements ---------- */
    "Schedule a post": "ልጥፍ መርሐግብር አስይዝ", "Edit post": "ልጥፍ አስተካክል", "Post to": "የሚለጠፍበት", "Send at (empty = now)": "የሚላክበት ጊዜ (ባዶ = አሁን)",
    "No posts.": "ልጥፍ የለም።", "Send now": "አሁን ላክ", "Preview to me": "ለእኔ አሳየኝ", "Preview sent to you": "ቅድመ እይታ ተልኮልዎታል",
    "Cancel post": "ልጥፍ ሰርዝ", "Cancel this post?": "ይህ ልጥፍ ይሰረዝ?", "It will not be published.": "አይታተምም።", "Publish now?": "አሁን ይታተም?",
    "The post goes to all chosen chats immediately.": "ልጥፉ ወዲያውኑ ወደ ሁሉም የተመረጡ ቻቶች ይላካል።", "Posting history": "የልጥፍ ታሪክ", "Not published yet.": "እስካሁን አልታተመም።",
    "Text (HTML allowed: <b> <i> <a>)": "ጽሑፍ (HTML ይፈቀዳል፦ <b> <i> <a>)", "No media": "ሚዲያ የለም", "Media link (https)": "የሚዲያ አገናኝ (https)",
    "Button text (optional)": "የአዝራር ጽሑፍ (አማራጭ)", "Button link": "የአዝራር አገናኝ", "(media only)": "(ሚዲያ ብቻ)",
    "New broadcast": "አዲስ ማሰራጫ", "Message (HTML allowed)": "መልዕክት (HTML ይፈቀዳል)", "Send to": "ተቀባዮች", "Everyone who can be reached": "መድረስ የሚቻልባቸው ሁሉ",
    "Verified users": "የተረጋገጡ ተጠቃሚዎች", "Active in the last 7 days": "ባለፉት 7 ቀናት ንቁ የነበሩ", "Users who completed a task": "ተግባር ያጠናቀቁ ተጠቃሚዎች",
    "Send to {n} users?": "ለ{n} ተጠቃሚዎች ይላክ?", "This reaches many people and cannot be undone once started. You can cancel while it runs.": "ይህ ብዙ ሰዎችን ይደርሳል፤ ከተጀመረ በኋላ መመለስ አይቻልም። በሚላክበት ጊዜ መሰረዝ ይችላሉ።",
    "Broadcast queued": "ማሰራጫው ተሰልፏል", "No broadcasts yet.": "እስካሁን ማሰራጫ የለም።", "{n} sent": "{n} ተልኳል", "{n} failed": "{n} አልተሳካም", "{n} total": "ጠቅላላ {n}",
    "Cancel this broadcast?": "ይህ ማሰራጫ ይሰረዝ?", "Messages already sent stay sent.": "ቀደም ብለው የተላኩ መልዕክቶች እንደተላኩ ይቆያሉ።", "Cancel it": "ሰርዘው",
    "New announcement": "አዲስ ማስታወቂያ", "No announcements.": "ማስታወቂያ የለም።", "Pin to the top": "ከላይ ሰካ", "{n} chat(s)": "{n} ቻት(ች)",

    /* ---------- admin: users ---------- */
    "Use search to find a specific user.": "የተወሰነ ተጠቃሚ ለማግኘት ፍለጋን ይጠቀሙ።", "No users found.": "ምንም ተጠቃሚ አልተገኘም።",
    "Reset verification": "ማረጋገጫን ዳግም አስጀምር", "Verification reset": "ማረጋገጫ ዳግም ተጀምሯል", "Edit balance": "ቀሪ ሂሳብ አስተካክል", "What do you want to do?": "ምን ማድረግ ይፈልጋሉ?", "Add money": "ገንዘብ ጨምር", "Remove money": "ገንዘብ ቀንስ", "Set the balance to": "ቀሪ ሂሳቡን ወደዚህ አድርግ",
    "Current available balance: {n} ETB": "አሁን ያለ ሊወጣ የሚችል ቀሪ ሂሳብ፦ {n} ብር", "Amount (ETB)": "መጠን (ብር)", "Reason (at least 5 letters, saved in the audit log)": "ምክንያት (ቢያንስ 5 ፊደላት፣ በመዝገብ ይቀመጣል)",
    "Nothing to change": "የሚቀየር ነገር የለም", "Change this balance?": "ይህ ቀሪ ሂሳብ ይቀየር?", "Balance changed by {} ETB": "ቀሪ ሂሳብ በ{} ብር ተቀይሯል", "Enter an amount.": "መጠን ያስገቡ።",
    "Adjust balance": "ቀሪ ሂሳብ አስተካክል",
    "Amount (negative to remove)": "መጠን (ለመቀነስ አሉታዊ)", "Reason (required, saved in the audit log)": "ምክንያት (ግዴታ፣ በመዝገብ ይቀመጣል)",
    "Balance adjusted": "ቀሪ ሂሳብ ተስተካክሏል", "Wallet history": "የቦርሳ ታሪክ", "Send for review": "ለግምገማ ላክ", "Hold for review": "ለግምገማ አቆይ",
    "Release hold": "ማቆየቱን አንሳ", "{n} users": "{n} ተጠቃሚዎች", "token …{}": "ቶከን …{}",
    "Nothing logged yet.": "እስካሁን የተመዘገበ የለም።", "Download reports (CSV)": "ሪፖርቶችን አውርድ (CSV)",
    "Exports are recorded in the audit log.": "ወደ ውጭ የተላኩ ፋይሎች በድርጊት መዝገብ ይመዘገባሉ።", "Downloaded": "ወርዷል",
    "user.suspend": "ተጠቃሚ ታግዷል", "user.reactivate": "ተጠቃሚ ተመልሷል", "user.hold": "ተጠቃሚ ለግምገማ ተይዟል", "user.release": "ማቆየት ተነስቷል",
    "user.reset_verification": "ማረጋገጫ ዳግም ተጀምሯል", "wallet.adjust": "ቀሪ ሂሳብ ተስተካክሏል", "task.create": "ተግባር ተፈጥሯል", "task.update": "ተግባር ተስተካክሏል",
    "task.archive": "ተግባር ወደ ማህደር ገብቷል", "channel.add": "ቻናል ተጨምሯል", "channel.remove": "ቻናል ተወግዷል", "post.schedule": "ልጥፍ ተይዟል", "post.edit": "ልጥፍ ተስተካክሏል",
    "post.cancel": "ልጥፍ ተሰርዟል", "post.send_now": "ልጥፍ ወዲያው ተላከ", "broadcast.create": "ማሰራጫ ተፈጥሯል", "broadcast.cancel": "ማሰራጫ ተሰርዟል",
    "announcement.create": "ማስታወቂያ ተፈጥሯል", "campaign.create": "ዘመቻ ተፈጥሯል", "claim.approve": "ማረጋገጫ ጸድቋል", "claim.reject": "ማረጋገጫ ውድቅ ተደርጓል",
    "claim.reverse": "ሽልማት ተመልሷል", "ticket.reply": "ለጥያቄ ተመልሷል", "settings.update": "ቅንብሮች ተቀይረዋል", "admin.save": "አስተዳዳሪ ተቀምጧል", "admin.remove": "አስተዳዳሪ ተወግዷል",
    "token.rotate": "ቶከን ተተክቷል", "guard.ban": "አውቶማቲክ እገዳ (ብዙ አካውንት)", "guard.hold": "አውቶማቲክ ግምገማ (ብዙ አካውንት)", "guard.flag": "አውቶማቲክ ማንቂያ (ብዙ አካውንት)",

    /* ---------- admin: bot settings form ---------- */
    "Pick the animal": "እንስሳውን ምረጥ", "Simple math": "ቀላል ሂሳብ", "Captcha": "ማረጋገጫ (ካፕቻ)", "Difficulty": "አስቸጋሪነት",
    "Seconds to answer": "ለመመለስ ሰከንዶች", "Tries before cooldown": "ከእረፍት ጊዜ በፊት ሙከራዎች", "Cooldown (minutes)": "የእረፍት ጊዜ (ደቂቃ)",
    "Require phone number": "የስልክ ቁጥር ይጠይቅ", "Strongest check against fake accounts.": "ከሐሰተኛ አካውንቶች ጠንካራው መከላከያ።",
    "Allowed phone prefix": "የሚፈቀድ የስልክ ቅድመ ቅጥያ", "Example +251. Empty = any country.": "ምሳሌ +251። ባዶ = ማንኛውም አገር።",
    "Referral rewards": "የግብዣ ሽልማቶች", "Reward per friend (ETB)": "በአንድ ጓደኛ ሽልማት (ብር)", "Friend must pass the check": "ጓደኛው ማረጋገጫውን ማለፍ አለበት",
    "Friend must finish N tasks": "ጓደኛው N ተግባራትን ማጠናቀቅ አለበት", "Max rewarded friends per user (0 = no limit)": "በአንድ ተጠቃሚ ከፍተኛ የሚሸለሙ ጓደኞች (0 = ገደብ የለም)",
    "Minimum (ETB)": "ዝቅተኛ (ብር)", "Maximum per request (0 = no limit)": "በአንድ ጥያቄ ከፍተኛ (0 = ገደብ የለም)", "Fee (%)": "ክፍያ (%)", "Flat fee (ETB)": "ቋሚ ክፍያ (ብር)",
    "Methods (comma separated)": "ዘዴዎች (በነጠላ ሰረዝ የተለዩ)", "Skip the Pending step (still paid manually)": "የመጠባበቅ ደረጃውን ዝለል (አሁንም በእጅ ይከፈላል)",
    "Re-check channel membership for N days (0 = off)": "የቻናል አባልነትን ለN ቀናት እንደገና ፈትሽ (0 = ጠፍቷል)", "Reverse the reward if the user leaves": "ተጠቃሚው ከወጣ ሽልማቱን መልስ",
    "The user is told and a reversal entry is added. Nothing is edited silently.": "ተጠቃሚው ይነገረዋል እና የመመለሻ መዝገብ ይጨመራል። ምንም ነገር በዝምታ አይቀየርም።",
    "Rules shown to users": "ለተጠቃሚዎች የሚታዩ ደንቦች", "Welcome message": "የእንኳን ደህና መጡ መልዕክት", "Welcome image link (https)": "የእንኳን ደህና መጡ ምስል አገናኝ (https)",
    "Help text": "የእገዛ ጽሑፍ", "Support username": "የድጋፍ ተጠቃሚ ስም", "Default language": "ነባሪ ቋንቋ", "Your time zone (hours from UTC)": "የእርስዎ የሰዓት ሰቅ (ከUTC ሰዓታት)",
    "Ethiopia is 3.": "ኢትዮጵያ 3 ናት።", "Pause tasks": "ተግባራትን አቁም", "Pause withdrawals": "ገንዘብ ማውጣትን አቁም", "Show leaderboard": "የደረጃ ሰንጠረዥ አሳይ",
    "Alert when a user claims more than N per hour": "ተጠቃሚ በሰዓት ከN በላይ ሲወስድ አስጠንቅቅ", "When (your time, UTC{})": "መቼ (የእርስዎ ሰዓት፣ UTC{})",
    "Several accounts on one phone": "በአንድ ስልክ ብዙ አካውንቶች", "Suspend the newer accounts": "አዲሶቹን አካውንቶች እገድ",
    "Hold newer accounts for review": "አዲሶቹን አካውንቶች ለግምገማ አቆይ", "Only alert me": "አስጠንቅቀኝ ብቻ",
    "The oldest account keeps working. A newer account on the same phone gets no referral reward. You can reactivate a family member from Users.": "የመጀመሪያው አካውንት መስራቱን ይቀጥላል። በዚያው ስልክ ላይ ያለ አዲስ አካውንት የግብዣ ሽልማት አያገኝም። የቤተሰብ አባልን ከ«ተጠቃሚዎች» መመለስ ይችላሉ።",
    "Paused (users see a maintenance message)": "ቆሟል (ተጠቃሚዎች የጥገና መልዕክት ያያሉ)",
    "Profile picture: set it in BotFather (Telegram does not allow changing it from here). Token ends in {}.": "የመገለጫ ፎቶ፦ በ BotFather ውስጥ ያዘጋጁ (ቴሌግራም ከዚህ መቀየር አይፈቅድም)። ቶከኑ የሚያልቀው በ {} ነው።",
    "Owner (everything)": "ባለቤት (ሁሉንም)", "Administrator": "አስተዳዳሪ", "Finance manager": "የፋይናንስ ኃላፊ", "Moderator": "ሞደሬተር", "Support agent": "የድጋፍ ሰጪ",
    "Add or change an admin": "አስተዳዳሪ ጨምር ወይም ቀይር", "No admins.": "አስተዳዳሪ የለም።", "Remove this admin?": "ይህ አስተዳዳሪ ይወገድ?", "They lose access right away.": "ወዲያውኑ መዳረሻቸውን ያጣሉ።",
    "Telegram id (numbers)": "ቴሌግራም መታወቂያ (ቁጥሮች)",

    /* ---------- controller ---------- */
    "Create a system": "ሲስተም ፍጠር", "Paste the token from BotFather. It is encrypted on the server and never shown again.": "ቶከኑን ከ BotFather ይለጥፉ። በሰርቨር ላይ ተመስጥሮ ይቀመጣል እና እንደገና አይታይም።",
    "Connect bot": "ቦት አገናኝ", "No systems yet.": "እስካሁን ሲስተም የለም።", "Set admin": "አስተዳዳሪ ሹም", "Set the bot admin": "የቦቱን አስተዳዳሪ ሹም",
    "Admin Telegram id": "የአስተዳዳሪ ቴሌግራም መታወቂያ", "The admin will not see you or know who set them up.": "አስተዳዳሪው እርስዎን አያይም፤ ማን እንዳቋቋመውም አያውቅም።",
    "New token": "አዲስ ቶከን", "Replace the token": "ቶከኑን ተካ", "Paste the new token for the same bot.": "ለዚሁ ቦት አዲሱን ቶከን ይለጥፉ።", "Token replaced": "ቶከን ተተክቷል",
    "Admins: {}": "አስተዳዳሪዎች፦ {}", "Connected @{}": "@{} ተገናኝቷል",

    /* ---------- messages from the server ---------- */
    "Open this page from Telegram.": "ይህንን ገጽ ከቴሌግራም ይክፈቱ።", "Your account is suspended.": "አካውንትዎ ታግዷል።", "This bot is paused.": "ይህ ቦት ለጊዜው ቆሟል።",
    "Too many requests. Slow down a little.": "ብዙ ጥያቄዎች ተላኩ። ትንሽ ዝግ ይበሉ።", "You are not an admin of this system.": "የዚህ ሲስተም አስተዳዳሪ አይደሉም።", "Your role cannot do this.": "ሚናዎ ይህን ማድረግ አይፈቅድም።",
    "This system does not exist.": "ይህ ሲስተም የለም።", "Not found.": "አልተገኘም።", "User not found.": "ተጠቃሚ አልተገኘም።", "Task not found.": "ተግባር አልተገኘም።", "Post not found.": "ልጥፍ አልተገኘም።",
    "Ticket not found.": "ጥያቄ አልተገኘም።", "Bot not found.": "ቦት አልተገኘም።", "Already handled.": "አስቀድሞ ተስተናግዷል።", "You already did this.": "ይህን አስቀድመው አድርገዋል።",
    "This task is full.": "ይህ ተግባር ሞልቷል።", "This task has ended.": "ይህ ተግባር አብቅቷል።", "This task is not available.": "ይህ ተግባር አይገኝም።", "Today's limit is reached.": "የዛሬው ገደብ ደርሷል።",
    "This part is paused for maintenance.": "ይህ ክፍል ለጥገና ቆሟል።", "Not enough balance.": "ቀሪ ሂሳብዎ በቂ አይደለም።", "Enter an amount.": "መጠን ያስገቡ።", "Enter a valid amount.": "ትክክለኛ መጠን ያስገቡ።",
    "Below the minimum withdrawal.": "ከዝቅተኛው የገንዘብ ማውጣት መጠን በታች ነው።", "Above the maximum withdrawal.": "ከከፍተኛው የገንዘብ ማውጣት መጠን በላይ ነው።", "Choose a withdrawal method.": "የገንዘብ ማውጫ ዘዴ ይምረጡ።",
    "Check the account number.": "የሂሳብ ቁጥሩን ያረጋግጡ።", "You already have a withdrawal in progress.": "አስቀድመው በሂደት ላይ ያለ ገንዘብ ማውጣት አለዎት።", "Enter the payment reference before marking it paid.": "ተከፍሏል ከማለትዎ በፊት የክፍያ ማጣቀሻ ያስገቡ።",
    "Write a short reason for rejecting.": "ለውድቅነቱ አጭር ምክንያት ይጻፉ።", "A reason (at least 5 letters) is required.": "ምክንያት (ቢያንስ 5 ፊደላት) ያስፈልጋል።", "Nothing to change.": "የሚቀየር ነገር የለም።", "Nothing to retry.": "እንደገና የሚሞከር ነገር የለም።",
    "That status change is not allowed.": "ይህ የሁኔታ ለውጥ አይፈቀድም።", "A button needs both text and link.": "አዝራር ጽሑፍ እና አገናኝ ሁለቱንም ይፈልጋል።", "Add the media link.": "የሚዲያ አገናኙን ያክሉ።", "Media must be photo or video.": "ሚዲያ ፎቶ ወይም ቪዲዮ መሆን አለበት።",
    "Write a message or add media.": "መልዕክት ይጻፉ ወይም ሚዲያ ያክሉ።", "Write the post text or add media.": "የልጥፉን ጽሑፍ ይጻፉ ወይም ሚዲያ ያክሉ።", "Choose at least one channel or group.": "ቢያንስ አንድ ቻናል ወይም ግሩፕ ይምረጡ።",
    "Choose one of your connected channels or groups.": "ከተገናኙት ቻናሎችዎ ወይም ግሩፖችዎ አንዱን ይምረጡ።", "Choose a task type.": "የተግባር አይነት ይምረጡ።", "A visit task needs a link.": "የገጽ ጉብኝት ተግባር አገናኝ ይፈልጋል።",
    "The end must be after the start.": "መጨረሻው ከመጀመሪያው በኋላ መሆን አለበት።", "Check the bonus amounts.": "የጉርሻ መጠኖችን ያረጋግጡ።", "Add at least one withdraw method.": "ቢያንስ አንድ የገንዘብ ማውጫ ዘዴ ያክሉ።",
    "Support username is not valid.": "የድጋፍ ተጠቃሚ ስም ትክክል አይደለም።", "Phone prefix looks like +251.": "የስልክ ቅድመ ቅጥያ ልክ እንደ +251 መሆን አለበት።", "Enter the @username or id of the channel or group.": "የቻናሉን ወይም ግሩፑን @username ወይም መታወቂያ ያስገቡ።",
    "I cannot find that chat. Check the name and add the bot as an admin.": "ያንን ቻት ማግኘት አልቻልኩም። ስሙን ያረጋግጡ እና ቦቱን አስተዳዳሪ ያድርጉት።", "This chat is already added.": "ይህ ቻት አስቀድሞ ተጨምሯል።",
    "Add this bot as an admin of the chat first (it needs to read members and post messages).": "መጀመሪያ ይህን ቦት የቻቱ አስተዳዳሪ ያድርጉት (አባላትን ማንበብ እና መልዕክት መለጠፍ ያስፈልገዋል)።",
    "Enter the numeric Telegram id.": "የቴሌግራም የቁጥር መታወቂያ ያስገቡ።", "Unknown role.": "ያልታወቀ ሚና።", "A system needs at least one owner.": "ሲስተም ቢያንስ አንድ ባለቤት ያስፈልገዋል።",
    "That does not look like a BotFather token.": "ይህ የ BotFather ቶከን አይመስልም።", "Telegram did not accept this token. Copy it again from BotFather.": "ቴሌግራም ይህን ቶከን አልተቀበለም። ከ BotFather እንደገና ይቅዱት።",
    "This bot is already connected.": "ይህ ቦት አስቀድሞ ተገናኝቷል።", "This token belongs to a different bot.": "ይህ ቶከን የሌላ ቦት ነው።", "This token does not belong to a bot.": "ይህ ቶከን የቦት አይደለም።",
    "Could not save the bot.": "ቦቱን ማስቀመጥ አልተቻለም።", "Could not save the token.": "ቶከኑን ማስቀመጥ አልተቻለም።", "Controller only.": "ለተቆጣጣሪ ብቻ።", "The controller bot is not configured.": "የተቆጣጣሪው ቦት አልተዋቀረም።",
    "I could not message you. Open the bot and press /start first.": "መልዕክት መላክ አልቻልኩም። መጀመሪያ ቦቱን ከፍተው /start ይጫኑ።", "Unknown action.": "ያልታወቀ ድርጊት።", "Unknown report.": "ያልታወቀ ሪፖርት።", "Unknown status.": "ያልታወቀ ሁኔታ።",
    "Repeat must be none, daily or weekly.": "መድገም ምንም፣ ዕለታዊ ወይም ሳምንታዊ መሆን አለበት።", "Status must be active or paused.": "ሁኔታ ንቁ ወይም ቆሟል መሆን አለበት።", "Reward must be between 0 and 100000 ETB.": "ሽልማት ከ0 እስከ 100000 ብር መሆን አለበት።",
    "{} is required.": "{} ያስፈልጋል።", "{} must be a full https link.": "{} ሙሉ የ https አገናኝ መሆን አለበት።", "{} must be between {n} and {n}.": "{1} ከ{2} እስከ {3} መሆን አለበት።", "{} is not a valid date.": "{} ትክክለኛ ቀን አይደለም።"
  };

  /* ---------- engine ---------- */
  var KEY = 'jb_lang';
  var lang = 'am';
  try { lang = localStorage.getItem(KEY) || 'am'; } catch (_) {}
  if (lang !== 'en' && lang !== 'am') lang = 'am';

  var exact = Object.create(null);
  var pats = [];
  var esc = function (s) { return s.replace(/[.*+?^$()|[\]\\]/g, '\\$&'); };
  Object.keys(D).forEach(function (k) {
    if (k.indexOf('{') === -1) { exact[k] = D[k]; return; }
    var re = esc(k).replace(/\{n\}/g, '(\\d[\\d,]*(?:\\.\\d+)?)').replace(/\{\}/g, '(.+?)');
    pats.push({ re: new RegExp('^' + re + '$'), out: D[k], len: k.length });
  });
  pats.sort(function (a, b) { return b.len - a.len; });

  function core(t, depth) {
    if (exact[t] !== undefined) return exact[t];
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].re.exec(t);
      if (!m) continue;
      var seq = 0;
      return pats[i].out.replace(/\{(\d)\}|\{n?\}/g, function (all, idx) {
        var g = m[idx ? Number(idx) : ++seq];
        if (g == null) return '';
        return depth < 3 ? core(g.trim(), depth + 1) : g;
      });
    }
    if (t.indexOf(' · ') > -1 && depth < 3) {              // lists like "Fee 5.00 · You get 45.00 · 2h"
      var parts = t.split(' · '), changed = false;
      var out = parts.map(function (p) { var r = core(p.trim(), depth + 1); if (r !== p.trim()) changed = true; return r; });
      if (changed) return out.join(' · ');
    }
    return t;
  }
  function tr(raw) {
    var t = raw.trim();
    if (!t) return raw;
    var r = core(t, 0);
    if (r === t) return raw;
    return raw.slice(0, raw.indexOf(t)) + r + raw.slice(raw.indexOf(t) + t.length);
  }
  var api = { tr: tr, dict: D };
  if (typeof window !== 'undefined') window.JBAM = api;
  if (typeof document === 'undefined' || !document.addEventListener) return;

  /* ---------- DOM ---------- */
  var origText = new WeakMap(), wroteText = new WeakMap(), origAttr = new WeakMap(), wroteAttr = new WeakMap();
  var ATTRS = ['placeholder', 'aria-label', 'title'];
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, NOSCRIPT: 1 };

  function doText(n) {
    var p = n.parentNode;
    if (!p || p.nodeType !== 1 || SKIP[p.nodeName]) return;
    if (p.closest && p.closest('[data-notr]')) return;
    var cur = n.nodeValue;
    if (lang === 'am') {
      if (wroteText.get(n) === cur) return;
      var out = tr(cur);
      if (out !== cur) { origText.set(n, cur); wroteText.set(n, out); n.nodeValue = out; }
    } else if (origText.has(n)) {
      n.nodeValue = origText.get(n); origText.delete(n); wroteText.delete(n);
    }
  }
  function doAttrs(el) {
    if (el.nodeType !== 1 || (el.closest && el.closest('[data-notr]'))) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var cur = el.getAttribute(a), wrote = wroteAttr.get(el) || {}, orig = origAttr.get(el) || {};
      if (lang === 'am') {
        if (wrote[a] === cur) continue;
        var out = tr(cur);
        if (out !== cur) { orig[a] = cur; wrote[a] = out; origAttr.set(el, orig); wroteAttr.set(el, wrote); el.setAttribute(a, out); }
      } else if (orig[a] !== undefined) {
        el.setAttribute(a, orig[a]); delete orig[a]; delete wrote[a];
      }
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1) return;
    doAttrs(root);
    var w = document.createTreeWalker(root, 5, null);   // 1 = elements, 4 = text
    var n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  function ensureButton() {
    var h = document.getElementById('hdr');
    if (!h || h.querySelector('#langBtn')) return;
    var b = document.createElement('button');
    b.id = 'langBtn'; b.className = 'pill tap'; b.setAttribute('data-notr', '1'); b.type = 'button';
    b.setAttribute('aria-label', 'Language');
    b.textContent = lang === 'am' ? 'EN' : 'አማ';
    b.style.marginLeft = '8px';
    b.onclick = function () { setLang(lang === 'am' ? 'en' : 'am'); };
    h.appendChild(b);
  }
  function setLang(l) {
    lang = l;
    try { localStorage.setItem(KEY, l); } catch (_) {}
    document.documentElement.lang = l;
    walk(document.body);
    var b = document.getElementById('langBtn');
    if (b) b.textContent = l === 'am' ? 'EN' : 'አማ';
  }

  var st = document.createElement('style');
  st.textContent = "html[lang=am] body{font-family:'Noto Sans Ethiopic',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}html[lang=am] .btn,html[lang=am] nav button{line-height:1.35}";
  document.head.appendChild(st);
  document.documentElement.lang = lang;

  function start() {
    walk(document.body);
    ensureButton();
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
        else if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
      }
      ensureButton();
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
