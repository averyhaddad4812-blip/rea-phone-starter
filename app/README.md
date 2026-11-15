# REA Studio

A private phone app, styled like a code editor, that does three things:

- **Build:** describe an app in plain words and watch it appear in a live preview, like Lovable. Ask for changes in chat until it's right. The **Code** tab shows every line.
- **Study:** check an open-source Android app with **REA (Reverse Engineer Anything)**: is it genuine, what can it access, does it go online.
- **Source code:** download the *whole* real source code of an open-source app (the exact version F-Droid built), browse every file, and ask the AI about any of them.

They connect. From an app's source code, tap **Build an app with this code**: the builder can reuse and translate that code, and adds the credit and license to your app automatically.

Every build follows **Craft Anything**'s steps, shown as a bar that fills in order:

| Step | What happens |
|---|---|
| **Study** | Optional: real code (or REA's report) from an app you studied |
| **Build** | Your chosen AI writes the app |
| **Check** | The preview watches for errors. If it finds one, tap **Fix it** |
| **Ready** | No errors: open it full screen or download it |

## AI models

Every text model on OpenRouter can be picked in Settings. Search by name (for example "gemini", "kimi" or "free"), and each one shows roughly what a build and a question cost. Muse isn't available, because Meta doesn't offer it to other apps.

## Licenses, in plain words

Everything you can study here is open source, so reading and reusing its code is allowed, as long as you follow its license:

- **Permissive licenses** (MIT, Apache, BSD): reuse freely and keep the credit.
- **Share-alike licenses** (GPL, AGPL, MPL and similar): keep the credit, and if you share or sell an app that uses the code, share your app's code under the same license too.

The app shows the license on every source and every remixed app, and the builder adds the credit for you. Closed-source and paid apps aren't supported: copying their code isn't legal.

## How it's built

| Part | What it does |
|---|---|
| `server.js` | The back room. No add-ons needed, just Node (plus Git for source code). Locked with your passcode. |
| `public/` | The phone screens: Home, Study, Report, Source, File, Build, Settings |
| `../Dockerfile` | A recipe for hosts that run Docker |

## Settings (set on the host, never in the code)

| Setting | What it's for |
|---|---|
| `APP_PASSCODE` | **Required.** Only people with this can use the app. Pick something long. |
| `OPENROUTER_API_KEY` | Optional. Easier: paste your key in the app's **Settings** screen. It's checked with OpenRouter, saved on the server only, and never sent back to the phone. |
| `OPENROUTER_MODEL` | Optional. The starting model. Default `anthropic/claude-sonnet-5.5`. |
| `MONTHLY_LIMIT_USD` | Optional. Default `20`. The AI pauses when the month's spending reaches it. |
| `DATA_DIR` | Optional. Where reports, source code, apps and spending are saved. |

## Run it yourself

```bash
bash scripts/setup.sh                       # once
APP_PASSCODE=your-passcode node app/server.js
# open http://localhost:8080
```

## Safety, built in

- Only open-source apps from F-Droid. REA only reads app files, never runs them.
- Source code downloads are limited to code and text files, size-capped, and the oldest are cleared automatically.
- **Sealed previews:** each built app runs in a locked-down sandbox with its own blank origin, so it can't see your passcode, your key or the rest of REA Studio. Preview links are signed and expire after 7 days. Built apps can still remember things: REA Studio saves their data on your server for them.
- Your OpenRouter key stays on the server. Wrong passcodes are slowed down, and spending has a hard monthly limit.

## Coming next

Save to GitHub, and publish an app to its own lasting link.
