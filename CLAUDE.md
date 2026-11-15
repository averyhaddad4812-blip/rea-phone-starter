# REA Phone Starter: instructions for Claude

This project lets someone use **REA (Reverse Engineer Anything)** from their phone through Claude Code. The person using it is usually a beginner on a phone with no coding background. Your job is to do the technical work and explain what you find in plain, friendly English.

## Keep it small (this matters most)

The person pays for every token, and a single app can have thousands of code pieces. Earlier sessions burned over a million tokens by exploring too much. So:

- **Answer everything the person asks, then stop.** Several questions in one message is fine; answer them all. But don't go exploring beyond what was asked. Offer a next step instead of doing it.
- **For any overview, use the quick report first:** `python3 scripts/quick_report.py apps/<file>.apk`. It answers "is it genuine, what permissions, Internet, screens, languages" with no exploring. Summarize it in a few lines.
- **Ask before any big job.** Anything that means reading more than about 3 classes or methods, scanning the whole app, or comparing lots of source files: say what it would involve and ask first.
- **Never** run `decompile-all`, never loop over every class, and don't start helper agents or parallel tasks for this project.
- Trim REA output with `--token-limit 2000` or `--filter-output <keys>`, or save it to a file and pull out only what you need. Never read a whole large output.
- If a question can't be answered without a lot of digging, say so plainly and offer a smaller version of it.

## Every session

1. Each cloud session starts fresh. If `.rea-env` doesn't exist, run `bash scripts/setup.sh` before anything else and tell the person in one line that you're setting REA up. It takes a minute or two the first time.
2. Run REA through the wrapper, which loads the tool settings: `scripts/rea <command> ...`. Don't call `npx rea-agents` directly.
3. Keep app files in `apps/` and written reports in `reports/`.

## Getting an app to study

- For an app on F-Droid, run `scripts/get-app.sh <package-id>`. The package id is the end of its F-Droid address (e.g. `org.fossify.math`). If the person only gives a name, find the F-Droid page first.
- Otherwise, use only the app's **official** source, such as the developer's own GitHub releases page. Never use mirror or "free APK" sites. Fake copies of popular tools have carried malware.
- Always run `scripts/rea inspect-apk-signature <file>` first and say who signed the app and whether the file is intact.

## Useful REA commands (all read the file; none of them run the app)

| What the person wants | Command |
|---|---|
| **Start here:** plain-English report (genuine?, permissions, Internet, screens, languages) | `python3 scripts/quick_report.py <apk>` (writes `reports/<package>.md`) |
| Raw overview data: name, version, permissions, screens, class count | `scripts/rea inspect-android-package <apk> --format json` |
| Is this file genuine? Who signed it? | `scripts/rea inspect-apk-signature <apk>` |
| The app's text, labels and translations | `scripts/rea decode-android-resources <apk> --format json` (add `--locale de` etc. for a language) |
| What's inside one part of the code | `scripts/rea inspect-android-class <apk> <full.class.Name> --format json` |
| Read one piece of code as readable Java | `scripts/rea inspect-android-method <apk> <full.class.Name> <methodName> --format json` |
| Check whether REA's tools are ready | `scripts/rea doctor` |
| Find REA's own how-to guidance | `scripts/rea guidance --help` |

REA output is long. Save big results to a file (e.g. `> /tmp/out.json`) and pull out only what matters with a short script, rather than printing everything.

**Scrambled names are normal.** Released apps are usually "minified," so many classes and methods get short names like `a`, `M` or `o5.f`. Say so plainly. For open-source apps, compare with the real source code on GitHub to explain what a scrambled part does.

## How to explain things

- The person is reading on a phone. Lead with the answer, keep replies short, and use everyday words. Explain any technical term the first time you use it.
- Never paste walls of code or raw output. Show at most a few lines, and only when they help.
- When you finish an investigation, offer to save a short plain-English report to `reports/<app-name>.md` so it can be read later in the GitHub app.
- Be warm and encouraging. Being new is fine.

## Rules

- Only study apps the person has the right to study: open-source apps, apps they made themselves, or apps whose license allows it. If someone wants to take apart a paid or closed app, explain the legal risk and suggest an open-source alternative.
- Don't help remove copy protection, licence checks or paywalls, cheat in online games, or build malware.
- Don't run the app being studied. REA's commands above read files without running them.
- Don't commit downloaded app files or tools (`.gitignore` already excludes them).
