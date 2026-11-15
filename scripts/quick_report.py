#!/usr/bin/env python3
"""Write a plain-English report about an Android app file using REA.

Runs three of REA's read-only checks (signature, package overview, text and
translations) and turns the results into a short Markdown report anyone can
read. No AI involved, so it costs no tokens.

Usage:
    python3 scripts/quick_report.py apps/some.app_12.apk [--source URL] [--out reports/some.app.md]
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REA = os.path.join(ROOT, "scripts", "rea")

# Android version for each "API level" an app can require.
ANDROID_VERSIONS = {
    21: "5.0", 22: "5.1", 23: "6", 24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1",
    28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14",
    35: "15", 36: "16", 37: "17",
}

# Plain-English meanings. True = a sensitive permission Android asks you about.
PERMISSIONS = {
    "INTERNET": ("Use the Internet", False),
    "ACCESS_NETWORK_STATE": ("See whether you're online", False),
    "ACCESS_WIFI_STATE": ("See Wi-Fi details", False),
    "CHANGE_WIFI_STATE": ("Turn Wi-Fi on or off", False),
    "CAMERA": ("Use the camera", True),
    "RECORD_AUDIO": ("Use the microphone", True),
    "ACCESS_FINE_LOCATION": ("Know your exact location", True),
    "ACCESS_COARSE_LOCATION": ("Know your rough location", True),
    "ACCESS_BACKGROUND_LOCATION": ("Know your location even when the app is closed", True),
    "READ_CONTACTS": ("Read your contacts", True),
    "WRITE_CONTACTS": ("Change your contacts", True),
    "GET_ACCOUNTS": ("See the accounts on your phone", True),
    "READ_CALENDAR": ("Read your calendar", True),
    "WRITE_CALENDAR": ("Change your calendar", True),
    "READ_EXTERNAL_STORAGE": ("Read files on your phone", True),
    "WRITE_EXTERNAL_STORAGE": ("Save files on your phone", True),
    "MANAGE_EXTERNAL_STORAGE": ("Manage all files on your phone", True),
    "READ_MEDIA_IMAGES": ("See your photos", True),
    "READ_MEDIA_VIDEO": ("See your videos", True),
    "READ_MEDIA_AUDIO": ("See your music and audio files", True),
    "READ_MEDIA_VISUAL_USER_SELECTED": ("See photos and videos you pick", True),
    "POST_NOTIFICATIONS": ("Show notifications", True),
    "CALL_PHONE": ("Make phone calls", True),
    "READ_PHONE_STATE": ("See phone status (like whether you're on a call)", True),
    "READ_PHONE_NUMBERS": ("See your phone number", True),
    "READ_CALL_LOG": ("Read your call history", True),
    "WRITE_CALL_LOG": ("Change your call history", True),
    "ANSWER_PHONE_CALLS": ("Answer phone calls", True),
    "SEND_SMS": ("Send text messages", True),
    "READ_SMS": ("Read your text messages", True),
    "RECEIVE_SMS": ("Receive text messages", True),
    "RECEIVE_MMS": ("Receive picture messages", True),
    "BODY_SENSORS": ("Read body sensors (like heart rate)", True),
    "ACTIVITY_RECOGNITION": ("Notice your physical activity (like walking)", True),
    "BLUETOOTH_CONNECT": ("Connect to Bluetooth devices", True),
    "BLUETOOTH_SCAN": ("Look for nearby Bluetooth devices", True),
    "BLUETOOTH_ADVERTISE": ("Make your phone visible over Bluetooth", True),
    "NEARBY_WIFI_DEVICES": ("Find nearby Wi-Fi devices", True),
    "UWB_RANGING": ("Measure distance to nearby devices", True),
    "BLUETOOTH": ("Use Bluetooth", False),
    "BLUETOOTH_ADMIN": ("Change Bluetooth settings", False),
    "NFC": ("Use tap-to-pay style NFC", False),
    "VIBRATE": ("Vibrate the phone", False),
    "WAKE_LOCK": ("Keep the phone awake while working", False),
    "RECEIVE_BOOT_COMPLETED": ("Start itself when the phone turns on", False),
    "FOREGROUND_SERVICE": ("Keep running with a visible notification", False),
    "SCHEDULE_EXACT_ALARM": ("Set exact alarms", False),
    "USE_EXACT_ALARM": ("Set exact alarms", False),
    "USE_BIOMETRIC": ("Use your fingerprint or face to unlock things", False),
    "USE_FINGERPRINT": ("Use your fingerprint to unlock things", False),
    "REQUEST_INSTALL_PACKAGES": ("Ask to install other apps", False),
    "REQUEST_DELETE_PACKAGES": ("Ask to uninstall apps", False),
    "QUERY_ALL_PACKAGES": ("See every app installed on your phone", False),
    "SYSTEM_ALERT_WINDOW": ("Draw over other apps", False),
    "USE_FULL_SCREEN_INTENT": ("Show full-screen alerts (like incoming calls)", False),
    "SET_WALLPAPER": ("Change your wallpaper", False),
    "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS": ("Ask to skip battery saving", False),
    "ACCESS_NOTIFICATION_POLICY": ("Change Do Not Disturb", False),
    "MODIFY_AUDIO_SETTINGS": ("Change sound settings", False),
    "FLASHLIGHT": ("Use the flashlight", False),
    "EXPAND_STATUS_BAR": ("Pull down the notification shade", False),
    "READ_APP_SPECIFIC_LOCALES": ("Read its own language setting", False),
}


def rea(*args):
    """Run one REA command; return (result, error_message)."""
    proc = subprocess.run([REA, *args, "--format", "json"], capture_output=True, text=True)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or ["no output"]
        return None, tail[0][:200]
    if proc.returncode != 0 or "normalized_result" not in data:
        message = data.get("message") or data.get("error") or "REA reported a problem"
        return None, str(message)[:200]
    return data["normalized_result"], None


def rea_version():
    """The REA version setup.sh recorded in .rea-env."""
    try:
        with open(os.path.join(ROOT, ".rea-env"), encoding="utf-8") as fh:
            match = re.search(r'REA_VERSION="([^"]+)"', fh.read())
        return match.group(1) if match else ""
    except OSError:
        return ""


def signer_name(subject):
    parts = dict(p.split("=", 1) for p in subject.splitlines() if "=" in p)
    org, person = parts.get("O"), parts.get("CN")
    if org and person and org != person:
        return f"{org} ({person})"
    return org or person or "an unnamed signer"


def signature_line(sig, err):
    if err:
        return f"❓ Couldn't check ({err})"
    signers, intact = [], []
    for scheme in ("v3.1", "v3", "v2", "v1"):
        block = sig.get("schemes", {}).get(scheme, {})
        for s in block.get("signers") or []:
            cert = s.get("certificate") or {}
            if cert.get("subject"):
                signers.append(signer_name(cert["subject"]))
            for d in s.get("digests") or []:
                if "matches_apk" in d:
                    intact.append(bool(d["matches_apk"]))
        if signers:
            break
    if not signers:
        return "❓ REA couldn't find a signature it could read"
    who = signers[0]
    note = " F-Droid builds it from the public source code." if "f-droid" in who.lower() else ""
    if intact and all(intact):
        return f"✅ Yes. Signed by **{who}**, and nothing has been changed since.{note}"
    if intact:
        return f"⚠️ Signed by **{who}**, but the signature **doesn't match** the file. Don't install it."
    return f"✅ Signed by **{who}**.{note}"


def friendly_permission(full):
    short = full.rsplit(".", 1)[-1]
    if full.startswith("android.permission.") and short in PERMISSIONS:
        meaning, sensitive = PERMISSIONS[short]
        return short, meaning, sensitive
    if full.startswith("android.permission.FOREGROUND_SERVICE_"):
        return short, "Keep a background task running (with a notification)", False
    if full.startswith("android.permission."):
        return short, "A standard Android permission", False
    if full.endswith(".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"):
        return short, "An automatic lock that keeps the app's private messages private", False
    if full == "com.android.alarm.permission.SET_ALARM":
        return short, "Set alarms in your clock app", False
    if full.startswith("com.google.android.c2dm") or full.endswith("C2D_MESSAGE"):
        return short, "Receive push messages through Google", False
    return full, "A custom permission made by the app or its developer", False


def friendly_screen(name, package):
    short = name[len(package) + 1:] if name.startswith(package + ".") else name
    short = short.rsplit(".", 1)[-1]
    short = re.sub(r"Activity$", "", short) or short
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", short)


def app_label(manifest_text, strings, fallback):
    match = re.search(r"<application\b[^>]*\bandroid:label=\"([^\"]+)\"", manifest_text or "")
    if not match:
        return fallback
    label = match.group(1)
    if label.startswith("@string/"):
        key = label.split("/", 1)[1]
        for s in strings or []:
            if s.get("name") == key and s.get("value"):
                return s["value"]
        return fallback
    return label


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("apk")
    parser.add_argument("--source", help="Where the app file came from (shown in the report)")
    parser.add_argument("--out", help="Report path (default: reports/<package>.md)")
    parser.add_argument("--json", help="Also save the key facts as JSON to this path")
    args = parser.parse_args()

    apk = os.path.abspath(args.apk)
    if not os.path.isfile(apk):
        sys.exit(f"❌ No app file at {args.apk}")

    print("⏳ Checking the signature...", file=sys.stderr)
    sig, sig_err = rea("inspect-apk-signature", apk)
    print("⏳ Reading the app's overview...", file=sys.stderr)
    pkg, pkg_err = rea("inspect-android-package", apk)
    print("⏳ Reading the app's text and translations...", file=sys.stderr)
    res, res_err = rea("decode-android-resources", apk, "--string-limit", "20000")

    if pkg_err:
        sys.exit(f"❌ REA couldn't read this app: {pkg_err}")

    package = pkg.get("package_name", "unknown")
    version = pkg.get("version_name") or pkg.get("version_code") or "?"
    manifest_text = (pkg.get("manifest") or {}).get("text", "")
    label = app_label(manifest_text, (res or {}).get("strings"), package)

    permissions = [friendly_permission(p) for p in pkg.get("permissions") or []]
    uses_internet = any(p[0] == "INTERNET" for p in permissions)
    sensitive = [p for p in permissions if p[2]]

    components = (pkg.get("components") or {}).get("items") or []
    screens = sorted({friendly_screen(c["name"], package)
                      for c in components if c.get("kind") == "activity"})
    # Activity aliases are mostly alternate launcher icons, so they aren't counted.
    shared = [c for c in components if c.get("exported") and c.get("kind") != "activity-alias"]

    try:
        min_sdk = int(pkg.get("min_sdk"))
        min_android = f"Android {ANDROID_VERSIONS.get(min_sdk, f'API {min_sdk}')} and newer"
    except (TypeError, ValueError):
        min_android = "unknown"

    with open(apk, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    size_mb = os.path.getsize(apk) / 1_000_000
    languages = len((res or {}).get("locales") or [])

    lines = [
        f"# 📱 {label}",
        "",
        f"`{package}` · version {version} · checked {datetime.date.today():%B %-d, %Y}",
        "",
        "## At a glance",
        "",
        f"- **Is the file genuine?** {signature_line(sig, sig_err)}",
        "- **Internet:** " + ("🌐 Yes, it can use the Internet." if uses_internet
                              else "🔒 No. It doesn't ask for Internet access."),
        f"- **Sensitive permissions:** {len(sensitive)}"
        + (" (see below)" if sensitive else ". Nothing Android would ask you about."),
        f"- **Works on:** {min_android}",
        f"- **Size:** {size_mb:.1f} MB",
        "- **Languages:** " + (f"about {languages}" if languages else
                                f"couldn't check ({res_err})" if res_err else "just one"),
        "",
        "## Permissions",
        "",
    ]
    if permissions:
        lines += ["| Permission | What it lets the app do |", "|---|---|"]
        for name, meaning, is_sensitive in sorted(permissions, key=lambda p: (not p[2], p[0])):
            lines.append(f"| {'⚠️ ' if is_sensitive else ''}`{name}` | {meaning} |")
        if sensitive:
            lines += ["", "⚠️ = a sensitive permission. Android asks you before allowing it."]
    else:
        lines.append("None. This app asks for no permissions at all.")

    lines += ["", "## Screens", ""]
    if screens:
        lines.append(f"The app has **{len(screens)}** screens:")
        lines.append("")
        lines += [f"- {s}" for s in screens[:20]]
        if len(screens) > 20:
            lines.append(f"- ...and {len(screens) - 20} more")
    else:
        lines.append("REA didn't find any screens.")

    classes = pkg.get("class_count")
    lines += [
        "",
        "## Under the hood",
        "",
        f"- **Code pieces (classes):** {classes:,}" if isinstance(classes, int)
        else f"- **Code pieces (classes):** {classes or '?'}",
        f"- **Parts other apps can open:** {len(shared)}"
        + (" (things like a home-screen widget, or ways to share into the app)" if shared
           else ". Other apps can only open it from its icon."),
        "",
        "## Where this came from",
        "",
    ]
    if args.source:
        lines.append(f"- **Downloaded from:** {args.source}")
    lines += [
        f"- **File fingerprint (SHA-256):** `{digest}`",
        f"- **Checked with:** REA {rea_version()}".rstrip(),
        "",
        "---",
        "",
        "💬 **Want to know more?** Open this project in Claude Code and ask things like",
        f"\"How does {label} save my settings?\" or \"Explain what the main screen does.\"",
        "",
    ]

    out = args.out or os.path.join(ROOT, "reports", f"{package}.md")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    if args.json:
        sig_text = signature_line(sig, sig_err)
        summary = {
            "label": label,
            "package": package,
            "version": str(version),
            "signature": sig_text.replace("**", ""),
            "genuine": sig_text.startswith("✅"),
            "uses_internet": uses_internet,
            "sensitive_permissions": [p[0] for p in sensitive],
            "permissions": [{"name": n, "meaning": m, "sensitive": s} for n, m, s in permissions],
            "screens": screens,
            "languages": languages,
            "works_on": min_android,
            "size_mb": round(size_mb, 1),
            "classes": classes,
            "shared_parts": len(shared),
            "sha256": digest,
            "source": args.source,
            "rea_version": rea_version(),
        }
        os.makedirs(os.path.dirname(os.path.abspath(args.json)), exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2)
    print(f"✅ Report saved to {os.path.relpath(out, ROOT)}", file=sys.stderr)
    print(out)


if __name__ == "__main__":
    main()
