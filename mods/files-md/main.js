// A lazy file browser for the focused pane's folder, with bounded read-only previews.
// Added (macOS theme): sort by name, last modified or created (newest first), with the date on
// each row; and while the panel slides open or shut (tabs-md, shared "panel.slide") the list
// keeps its open width and rides the panel's edge instead of re-wrapping every frame.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, shared, layout } from "herdr";

// The panels share data in one VM, but their host tasks belong to separate copies.
const scans = globalThis[Symbol.for("herdr.repoStatus.v2")] ??= new Map();

async function repoStatus(root, on, { after, visiting, urgent, allowInactive }, cx, current) {
  const repo = JSON.stringify([on, root]), now = Date.now();
  for (const [key, scan] of scans) {
    if (scan.pollAt <= now || (!scan.pollAt && scan.task.is_done())) scans.delete(key);
  }
  while (current()) {
    let scan = scans.get(repo);
    const pending = scan && !scan.pollAt && !scan.task.is_done();
    const reusable = scan?.status?.code === 0 && Date.now() < scan.pollAt
      && (scan.started >= after || (!urgent && Date.now() < scan.watchAt));
    if (!reusable && (!pending || (visiting && scan.started !== undefined && scan.started < after))) {
      if (!allowInactive && window()?.active === false) return null;
      const next = {};
      next.task = cx.spawn(async cx => {
        await cx.sleep(25); // Let both listeners for a watch batch join before starting Git.
        if (!allowInactive && window()?.active === false) return;
        next.started = Date.now();
        try {
          next.status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
        } catch (error) {
          next.error = error;
        } finally {
          const finished = Date.now(), duration = finished - next.started;
          const delay = duration < 500 ? 0 : Math.min(60000, 5 * duration);
          next.watchAt = finished + delay;
          next.pollAt = finished + Math.max(10000, delay);
          if (next.status?.code !== 0 && scans.get(repo) === next) scans.delete(repo);
        }
      });
      scans.set(repo, next);
      scan = next;
    }
    // Resume through our own host task, so another copy's close cannot cancel our follow-up work.
    while (current() && !scan.pollAt && !scan.task.is_done()) await cx.sleep(50);
    if (!current()) return null;
    if (!scan.pollAt) continue; // The scanning copy closed or reloaded.
    return scan;
  }
  return null;
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

// Added: sorting. "name": folders first, then A–Z (Herdr's order). "modified" / "created": newest
// first, folders and files together, as Finder's date columns do.
const SORTS = [
  { id: "name", label: "Name" },
  { id: "modified", label: "Modified" },
  { id: "created", label: "Created" },
];
// Added: dot files (names starting with "."): shown unless hidden with the eye button; remembered.
const hidingDots = () => localStorage.getItem("hideDots") === "1";
const sortOf = () => SORTS.find((x) => x.id === localStorage.getItem("sort")) ?? SORTS[0];
const stamp = (entry, id) => (id === "created" ? (entry.created > 0 ? entry.created : entry.modified) : entry.modified) ?? 0;
function sortEntries(entries, id) {
  if (id === "name") return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return entries.sort((a, b) => stamp(b, id) - stamp(a, id) || a.name.localeCompare(b.name));
}
// Added: the panel's slide (tabs-md): while it's narrower than its open width, the list keeps that
// width (the panel has no padding, so it's the panel's), riding the edge instead of re-wrapping.
function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const hit = findNode(child, id); if (hit) return hit; }
  return null;
}

// A row's date: the time today, the day this year, else the year.
function shortDate(seconds) {
  if (!seconds) return "";
  const d = new Date(seconds * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return String(d.getFullYear());
}
// Modified and created times (seconds) of a folder's entries, by name: one find + stat for the
// whole folder (BSD stat on macOS, GNU elsewhere; GNU's %W is 0 where the filesystem keeps no
// birth time). Empty on Windows or when it fails: the list then sorts as by name within dates of 0.
async function times(path, on) {
  if (!on && window()?.platform === "windows") return new Map();
  const script = 'if stat -f %m . >/dev/null 2>&1; then find "$1" -mindepth 1 -maxdepth 1 ! -name .git -exec stat -f "%m %B %N" {} +; else find "$1" -mindepth 1 -maxdepth 1 ! -name .git -exec stat -c "%Y %W %n" {} +; fi';
  const r = await exec("sh", ["-c", script, "files", path], { on }).catch(() => null);
  const out = new Map();
  for (const line of String(r?.stdout ?? "").split("\n")) {
    const m = /^(\d+) (-?\d+) (.*)$/.exec(line);
    if (m) out.set(m[3].slice(m[3].lastIndexOf("/") + 1), { modified: Number(m[1]), created: Number(m[2]) });
  }
  return out;
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(500, cx => this.refreshIfDue(cx));
  }

  refreshIfDue(cx) {
    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context) return;
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading) return;
    const now = Date.now();
    if (context.catchUp || (context.dirtyAt && now >= context.watchAt) || now >= context.pollAt) this.refresh(cx);
  }

  watch(root, context, cx) {
    if (context.on || context.watch?.root === root) return;
    context.watch?.pending?.cancel();
    const watch = { root };
    context.watch = watch;
    cx.spawn(async cx => {
      try {
        while (this.context === context && context.watch === watch) {
          watch.pending = watchFolder(root);
          const paths = await watch.pending;
          if (paths.length && context.watch === watch && this.current(context)) {
            context.dirtyAt = Date.now() + 1;
            this.refreshIfDue(cx);
          }
        }
      } catch {
        if (context.watch === watch) context.watch = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  // Added: the next sort; loaded folders are listed again (dates are fetched only when needed).
  cycleSort(cx) {
    const i = SORTS.indexOf(sortOf());
    localStorage.setItem("sort", SORTS[(i + 1) % SORTS.length].id);
    const context = this.context;
    if (!context) { cx.notify(); return; }
    cx.spawn(async (cx) => {
      for (const path of [...this.entries.keys()]) {
        try { await this.loadFolder(path, context); } catch { /* the next refresh tries again */ }
      }
      cx.notify();
    });
    cx.notify();
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const full = path ? `${root}/${path}` : root, sort = sortOf().id;
    // Changed: by date, the dates come with the listing (one more exec per folder).
    const [entries, dates] = await Promise.all([directory(full, on), sort === "name" ? null : times(full, on)]);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    if (dates) for (const entry of entries) Object.assign(entry, dates.get(entry.name) ?? {});
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, sortEntries(entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))), sort));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    const visiting = next !== this.context?.key;
    if (visiting) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders, file: this.file });
        this.context.watch?.pending?.cancel();
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, dirtyAt: 0 }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    const context = this.context;
    const now = Date.now();
    if (!cwd) {
      context.catchUp = false;
      context.dirtyAt = 0;
      context.pollAt = now + 10000;
      return;
    }
    if (this.loading) return;
    if (context.catchUp && !context.dirtyAt) context.dirtyAt = now + 1;
    const request = {
      after: visiting ? now + 1 : context.dirtyAt || (context.lastStatus ?? -1) + 1,
      visiting,
      urgent: visiting || context.catchUp,
      allowInactive: visiting,
    };
    context.catchUp = false;
    context.pollAt = context.watchAt = now + 10000;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        this.watch(cwd, context, cx);
        const dirtyAtListing = context.dirtyAt;
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        if (!this.current(context)) return;
        const marks = {};
        let covered = dirtyAtListing;
        if (top?.code === 0) {
          const root = top.stdout.trim();
          const scan = await repoStatus(root, on, request, cx, () => this.context === context);
          if (!scan || !this.current(context)) return;
          const { status, started, pollAt, watchAt } = scan;
          context.lastStatus = started;
          context.pollAt = pollAt;
          context.watchAt = watchAt;
          covered = Math.min(dirtyAtListing, started);
          if (request.urgent && request.after > started) context.catchUp = true;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${root}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        } else {
          context.watchAt = Date.now();
        }
        if (!this.current(context)) return;
        if (context.dirtyAt <= covered) context.dirtyAt = 0;
        this.marks = marks; this.error = null;
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      if (hidingDots() && entry.name.startsWith(".")) continue; // Added
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/files-md/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-md/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(sortOf().id !== "name" && Boolean(stamp(entry, sortOf().id)), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(shortDate(stamp(entry, sortOf().id))))) // Added
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    else this.refreshIfDue(cx);
    const t = theme();
    const font = this.code ? settings() : null;
    // Added: during the panel's slide, keep the open width.
    const slide = shared("panel.slide"), px = findNode(layout(), "panel")?.size?.px;
    const sliding = Boolean(slide) && Date.now() < slide.until && typeof px === "number" && px < slide.open;
    if (slide && Date.now() < slide.until && this.slideSeen !== slide.id) {
      this.slideSeen = slide.id; // one redraw after the slide ends, not one per frame
      cx.timer.after(Math.max(0, slide.until - Date.now()) + 10, (cx) => cx.notify());
    }
    // The same elements during and outside a slide (switching structure mid-slide rebuilt the list
    // and stuttered); only the inner width changes.
    return div().id("files-frame").size_full().overflow_hidden()
      .child(div().id("files-ride").h_full().flex_none()
        .when(sliding, (d) => d.w(slide.open)).when(!sliding, (d) => d.w_full())
        .child(this.panel(t, font)));
  }

  // Changed: the panel itself, as Herdr's render drew it.
  panel(t, font) {
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        // Added: the sort; a click moves on to the next (Name, Modified, Created).
        .when(!this.file, el => el.child(h_flex().id("files-sort").flex_none().h(22).px(6).gap(3).items_center().rounded(5)
          .text_size(11.5).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`Sorted by ${sortOf().label.toLowerCase()}${sortOf().id === "name" ? "" : ", newest first"}. Click to change.`)
          .on_click((_e, cx) => this.cycleSort(cx))
          .child(sortOf().label).child(svg("mods/files-md/chevron-down.svg").size(10))))
        // Added: show or hide dot files.
        .when(!this.file, el => el.child(div().id("files-dots").flex_none().size(22).flex().items_center().justify_center().rounded(5)
          .text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(hidingDots() ? "Dot files hidden. Click to show them." : "Click to hide dot files.")
          .on_click((_e, cx) => { localStorage.setItem("hideDots", hidingDots() ? "0" : "1"); cx.notify(); })
          .child(svg(`mods/files-md/${hidingDots() ? "eye-off" : "eye"}.svg`).size(14)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code
        ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
