# 🌈 REA Studio

A private phone app that does two things:

- **Build:** describe an app in plain words and watch it appear in a live preview, like Lovable. Ask for changes in chat until it's right.
- **Study:** take apart an open-source Android app with **REA (Reverse Engineer Anything)** and get a plain-English explanation.

The two connect. After studying an app, tap **Build something inspired by this**. The builder gets REA's report as ideas only and writes all its code fresh.

Every build follows **Craft Anything**'s steps, shown as a rainbow bar that lights up in order:

| Step | What happens |
|---|---|
| **Study** | Optional: ideas from an app you studied with REA |
| **Build** | Your chosen AI writes the app |
| **Check** | The preview watches for errors. If it finds one, tap **Fix it** |
| **Ready** | No errors: open it full screen or download it |

It installs to your home screen like a normal app (it's a "PWA", a website that acts like an app).

## AI brains

Pick one in Settings. All of them go through your OpenRouter account: Claude Sonnet 5.5 (the default), Claude Opus 5.5, Claude Haiku 5.5, ChatGPT, Gemini and Kimi. Muse isn't available, because Meta doesn't offer it to other apps.

## How it's built

| Part | What it does |
|---|---|
| `server.js` | The back room. No add-ons needed, just Node. Locked with your passcode. |
| `public/` | The phone screens: Home, Study, Report, Build, Settings |
| `../Dockerfile` | A recipe for hosts that run Docker |

The back room reuses the kit's own scripts (`get-app.sh`, `quick_report.py`), so the app and the Run button always agree.

## Settings (set on the host, never in the code)

| Setting | What it's for |
|---|---|
| `APP_PASSCODE` | **Required.** Only people with this can use the app. Pick something long. |
| `OPENROUTER_API_KEY` | Optional. Easier: paste your key in the app's **Settings** screen. It's checked with OpenRouter, saved on the server only, and never sent back to the phone. |
| `OPENROUTER_MODEL` | Optional. The starting brain. Default `anthropic/claude-sonnet-5.5`. |
| `MONTHLY_LIMIT_USD` | Optional. Default `20`. The AI pauses when the month's spending reaches it. |
| `DATA_DIR` | Optional. Where reports, apps and spending are saved. |

## Run it yourself

```bash
bash scripts/setup.sh                       # once
APP_PASSCODE=your-passcode node app/server.js
# open http://localhost:8080
```

## Safety, built in

- **Study** only accepts F-Droid apps (every F-Droid app is open source). REA only reads the file, never runs it, and the file is deleted after the check.
- **Build** is clean-room: it can use REA's report for ideas, never another app's code, art or branding. It won't build fake login or payment pages.
- **Sealed previews:** each built app runs in a locked-down sandbox with its own blank origin, so it can't see your passcode, your key or the rest of REA Studio. Preview links are signed and expire after 7 days.
- Built apps can still remember things: REA Studio saves their data on your server for them.
- Your OpenRouter key stays on the server. Wrong passcodes are slowed down, and spending has a hard monthly limit.

## Costs, roughly (with Claude Sonnet 5.5)

- A Study question: about 1¢.
- A new app or a change: about 5 to 20¢, depending on the app's size.

## Coming next

Save to GitHub, publish an app to its own link, and a reviewer brain that double-checks builds.
