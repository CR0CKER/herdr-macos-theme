// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.
// Added: opt-in, every notification goes to the system instead: set { "system": true } in the
// user's own ~/.config/herdr-app/notifications.json. macOS: terminal-notifier (a click brings
// Herdr forward and runs the toast's action), else AppleScript's `display notification` (shown as
// Script Editor's; a click opens Script Editor) while terminal-notifier is missing or not yet
// allowed (see README). Linux: notify-send. If posting fails, the toast below shows, with a hint.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, exec, readTextFile, appHome, home, window, checking } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

// Added: system notifications.
const SETTINGS_FILE = "notifications.json";
const BUNDLE_ID = "dev.herdr.app"; // terminal-notifier -activate: a click brings Herdr forward
const NOTIFIER = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier", "/Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier"];
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // for the shell line a click runs

// A program's path: the first of `candidates` that exists (checked each time, in order, so a
// preferred one added later wins), else the login shell's PATH (remembered). null when there's none.
async function locate(key, name, candidates) {
  for (const path of candidates) {
    const r = await exec("/bin/test", ["-x", path]).catch(() => null);
    if (r?.code === 0) return path;
  }
  const known = localStorage.getItem(key);
  if (known) return known;
  const r = await exec("/bin/sh", ["-lc", `command -v ${name}`]).catch(() => null);
  const found = String(r?.stdout ?? "").trim();
  if (r?.code === 0 && found.startsWith("/")) { localStorage.setItem(key, found); return found; }
  return null;
}

async function wantsSystem() {
  const text = await readTextFile(`${appHome()}/${SETTINGS_FILE}`).catch(() => null);
  try { return JSON.parse(text ?? "{}")?.system === true; } catch { return false; }
}

// AppleScript's notification; title and body go in as arguments, so nothing needs escaping.
async function appleScript(title, body) {
  const script = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];
  const r = await exec("/usr/bin/osascript", [...script.flatMap((line) => ["-e", line]), title, body || title]).catch(() => null);
  return r?.code === 0;
}

// Posts `p` to the system: "ok", "missing" (no way to post) or "refused" (it ran but failed).
async function post(p) {
  const title = String(p.title || "Herdr"), body = String(p.body ?? "");
  if (window()?.platform === "linux") {
    const r = await exec("notify-send", ["-a", "Herdr", title, body]).catch(() => null);
    return !r ? "missing" : r.code === 0 ? "ok" : "refused";
  }
  // "Herdr Notifications": a copy of terminal-notifier with Herdr's name and icon (see README).
  const tool = await locate("notifier", "terminal-notifier", [`${home()}/Applications/Herdr Notifications.app/Contents/MacOS/terminal-notifier`,
    `${home()}/Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier`, ...NOTIFIER]);
  if (!tool) return (await appleScript(title, body)) ? "ok" : "missing";
  // No -group: notifications with the same title (two agents both "Done") must not replace each other.
  const args = ["-title", title, "-message", body || title, "-activate", BUNDLE_ID];
  if (p.action?.name) {
    const app = await locate("herdr-app", "herdr-app", [`${home()}/.local/bin/herdr-app`, "/Applications/Herdr.app/Contents/MacOS/Herdr"]);
    if (app) args.push("-execute", `${quote(app)} do ${quote(p.action.name)} ${quote(JSON.stringify(p.action.args ?? {}))}`);
  }
  const r = await exec(tool, args).catch(() => null);
  if (r?.code === 0) return "ok";
  if (!r) localStorage.removeItem("notifier"); // couldn't start: look for it again next time
  // Refused (e.g. macOS hasn't allowed it yet): AppleScript for this one; terminal-notifier is
  // tried again next time, so allowing it in Settings takes effect at once.
  return (await appleScript(title, body)) ? "ok" : "refused";
}

export default class Toast extends View {
  // Added: decide between the system and this toast. The last answer is remembered, so a toast
  // that stays in the app shows at once; one that may go to the system draws nothing meanwhile.
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = localStorage.getItem("system") === "0" ? "app" : null;
    if (checking()) { this.mode = "app"; return; }
    cx.spawn(async (cx) => {
      const system = await wantsSystem();
      localStorage.setItem("system", system ? "1" : "0");
      const sent = system ? await post(p) : null;
      if (sent === "ok") { closeOverlay(p.overlay); return; }
      if (sent === "missing" || sent === "refused") this.hint = "Couldn't reach Notification Center: allow terminal-notifier or Script Editor in System Settings > Notifications";
      if (this.mode !== "app") { this.mode = "app"; cx.notify(); }
    });
  }

  render(cx) {
    if (this.mode !== "app") return div(); // Added: deciding
    const t = theme();
    const p = this.hint ? { ...(props() ?? {}), body: this.hint } : (props() ?? {}); // Changed: the hint, when posting failed
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    const text = (value) => p.fitHeight
      ? div().child(value)
      : div().truncate().child(typeof value === "string" ? value.split("\n", 1)[0] : value);
    return h_flex()
      .id("toast")
      .when(p.fitHeight, (el) => el.w_full().min_h(70).flex_none().py(12))
      .when(!p.fitHeight, (el) => el.size_full())
      .px(18)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .child(text(login ? `${login[1]} needs a login: run` : p.title ?? "").font_semibold().text_size(13).text_color(t.foreground))
          .when(!login && Boolean(p.body), (el) => el.child(text(p.body).text_size(12).text_color(t.muted)))
          .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
            .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
              .child(this.copied ? "Copied" : "Copy")))),
      );
  }
}
