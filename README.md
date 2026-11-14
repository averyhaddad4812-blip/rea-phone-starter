# 📱 REA Phone Starter

Take apart Android apps and see how they work, right from your phone.

This kit sets up **[REA (Reverse Engineer Anything)](https://github.com/morluto/rea)** inside Claude Code, so you can just *ask* questions like "Is this app genuine?" or "How does this feature work?" and get plain-English answers. No computer, no coding experience needed.

## Why this exists

REA is a powerful open-source tool, but it's built for computers. It can't install on a phone, and to look inside Android apps it needs two extra tools it doesn't install itself. This kit handles all of that for you in one step, inside Claude Code's cloud computer, which you control from the Claude app.

## What you need

- The **Claude app** with access to Claude Code
- A free **GitHub** account, with this project in it

## How to use it

1. **Open Claude Code** in the Claude app and start a session on this project (`rea-phone-starter`).
2. **Say:** "Set up REA." Claude runs the setup. It takes a minute or two, and happens once per session.
3. **Ask away.** For example: "Get Fossify Calculator from F-Droid and tell me about it."

Not sure what to ask? See **[STARTER-QUESTIONS.md](STARTER-QUESTIONS.md)**.

## What REA can show you

- ✅ Whether an app file is **genuine** and who signed it
- ✅ What **permissions** an app asks for, and whether it uses the Internet
- ✅ The app's **screens**, text and translations
- ✅ The app's **code**, turned back into readable form, one piece at a time

**A heads-up:** most released apps have their code "minified," so lots of names look scrambled (like `a`, `M` or `o5.f`). That's normal. For open-source apps, Claude can compare what it finds with the real source code on GitHub to explain what each piece does.

## Staying safe and legal

- **Only take apart apps you have the right to study.** That means open-source apps (everything on [F-Droid](https://f-droid.org) is open source), apps you made yourself, or apps whose license allows it. Taking apart paid or closed apps can break their license.
- **Only download apps from official places,** like F-Droid or the developer's own GitHub page. Fake copies of popular tools have carried malware.
- **Nothing gets run.** REA reads app files without running them.
- **Every tool download is checked.** The setup compares each tool against its known fingerprint and deletes anything that doesn't match.

## If something goes wrong

| What you see | What to do |
|---|---|
| "REA isn't set up in this session yet" | Say "Set up REA." Every new session starts fresh. |
| A download fails during setup | This session may be blocking downloads from GitHub or F-Droid. Your Claude Code environment's network setting may need to allow those sites. |
| "didn't match its expected fingerprint" | The download was damaged or changed, and it was deleted for safety. Try again later. |
| Lots of scrambled names | That's normal for released apps (see above). |

## What's inside

| File | What it does |
|---|---|
| `scripts/setup.sh` | Installs REA and its two Android tools, checks every download |
| `scripts/rea` | Runs REA with the right settings |
| `scripts/get-app.sh` | Downloads the newest version of an app from F-Droid |
| `CLAUDE.md` | Instructions Claude reads automatically: how to use REA and explain things simply |
| `STARTER-QUESTIONS.md` | Ready-made questions to try |
| `apps/` | Where app files go (not saved to GitHub) |
| `reports/` | Plain-English write-ups you can read later |

## Credits

This kit just connects existing open-source tools:

- [REA](https://github.com/morluto/rea), the reverse-engineering toolkit
- [jadx-headless-mcp](https://github.com/1013503897/jadx-headless-mcp), which turns Android code back into readable form
- [Apktool](https://github.com/iBotPeaches/Apktool), which unpacks an app's settings, text and translations
