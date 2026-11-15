# 📱 REA Studio (Version 1)

A private phone app for understanding open-source Android apps. Type an app's F-Droid id or link, ask a question, and get:

- a **safety check** (open-source apps from F-Droid only, read-only "clean-room" checks),
- a **real REA check** of the app file (genuine? Internet? permissions? languages? screens?),
- **Claude's plain-English answer** (through your OpenRouter account), with what the check couldn't see.

It installs to your home screen like a normal app (it's a "PWA", a website that acts like an app).

## How it's built

| Part | What it does |
|---|---|
| `server.js` | The back room. No add-ons needed, just Node. Locked with your passcode. |
| `public/` | The phone screens: Home, Chat, Report, Settings |
| `../Dockerfile` | One recipe that puts the back room, REA and its tools in one box for hosting |

The back room reuses the kit's own scripts (`get-app.sh`, `quick_report.py`), so the app and the Run button always agree.

## Settings (set on the host, never in the code)

| Setting | What it's for |
|---|---|
| `APP_PASSCODE` | **Required.** Only people with this can use the app. Pick something long. |
| `OPENROUTER_API_KEY` | Optional. Easier: paste your key in the app's **Settings** screen. It's checked with OpenRouter, saved on the server only, and never sent back to the phone. Without a key you still get reports. |
| `OPENROUTER_MODEL` | Optional. Default `anthropic/claude-sonnet-5.5` (about a cent per question). |
| `MONTHLY_LIMIT_USD` | Optional. Default `20`. Claude pauses when the month's spending reaches it. |
| `DATA_DIR` | Optional. Where reports and spending are saved. Use a lasting disk if your host offers one. |

## Run it yourself

```bash
bash scripts/setup.sh                       # once
APP_PASSCODE=your-passcode node app/server.js
# open http://localhost:8080
```

Or with Docker: `docker build -t rea-studio . && docker run -p 8080:8080 -e APP_PASSCODE=... -e OPENROUTER_API_KEY=... rea-studio`

## Safety, built in

- Only F-Droid package ids are accepted (every F-Droid app is open source), and they're checked before anything runs.
- Nothing from the app being studied is ever run. REA only reads the file, and the file is deleted after the check.
- Your OpenRouter key stays on the server. The phone never sees it.
- One investigation at a time, wrong passcodes are slowed down, and spending has a hard monthly limit.

## Coming next (see the plan)

Version 1.5 saves reports to GitHub · Version 2 adds ChatGPT and Gemini, plus a reviewer brain · Version 3 adds a build mode.
