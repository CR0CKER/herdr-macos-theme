// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder. Added: drop an agent's tab here to move it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, HoverCard } from "gpui-base";
import { spaces, agents, machines, panes, terminals, home, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, notify } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too. Changed:
// during a toggle's slide (shared "sidebar.slide", until it settles or its time is up) the sidebar
// keeps its open layout, both ways.
const slideNow = () => { const s = shared("sidebar.slide"); return Boolean(s) && !s.settled && typeof s.until === "number" && Date.now() < s.until; };
const narrow = () => !slideNow() && (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Added: a toggle's slide moves the open sidebar rather than re-laying it out: the content keeps
// its open width in a clipping box and its right edge rides the sidebar's edge, so nothing inside
// re-wraps from frame to frame. Whenever the sidebar switches between open and the rail (as a
// fold settles, as an unfold starts, a drag of its edge) the new content fades and slides in,
// starting partly visible so no frame shows an empty sidebar. Native transitions, no loop.
// `clip` false: only the fade (for content that already follows the edge, like the header).
const FADE_IN = { duration: 180, easing: "ease-out" };
function fade(view, el, cx, clip = true) {
  const mode = narrow();
  if (view.lastMode !== undefined && view.lastMode !== mode && cx) {
    view.entering = true;
    cx.timer.after(16, (cx) => { view.entering = false; cx.notify(); });
  }
  view.lastMode = mode;
  const slide = shared("sidebar.slide");
  // A slide whose record wasn't cleared still ends on time.
  if (cx && slideNow()) cx.timer.after(Math.max(0, slide.until - Date.now()) + 10, (cx) => cx.notify());
  const content = view.entering
    ? el.relative().left(-4).opacity(0.35)
    : el.relative().left(0).opacity(1).transition("opacity", FADE_IN).transition("left", FADE_IN);
  if (!clip) return content;
  const px = find(layout(), "sidebar")?.size?.px;
  const open = shared("sidebar.width") ?? 268;
  const moving = slideNow() && typeof px === "number" && px < open;
  return div().size_full().overflow_hidden().child(div().relative().h_full().flex_none()
    .when(moving, (d) => d.w(open).left(px - open))
    .when(!moving, (d) => d.size_full())
    .child(content));
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
// Added (rail): sizes for the larger space badges and the agents grouped under them.
const RAIL_BIG = 60, BADGE = 44, AGENT_CELL = 40, AGENT_ICON = 28, RING = 2, RING_GAP = 3, ACTIVE_BAR = 4;
// "Needs you" pulses (native loop, runs without the script).
const PULSE = { from: 0.3, to: 1, period: 1200 };
// Added: hover cards on the rail (name, folder, shortcut, agents and their status).
const STATUS_TEXT = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle", unknown: "Unknown" };
const tilde = (path) => { const h = home(); return path && h && path.startsWith(h) ? "~" + path.slice(h.length) : path || ""; };
const agentName = (a) => a.pane_name || a.tab_name || a.title || a.program?.name || a.address;
const SHORTCUT_PREFIX = "⌃"; // keys.json: ctrl-1..9 select spaces 1..9
const CARD_DELAY = 600; // ms of resting on an icon before its card shows (a click hides it anyway)
// Program icons whose SVG says width/height="1em" render with seams when scaled; a copy with a
// real 24x24 size in this mod's icons/ is used instead when there is one.
const FIXED_ICONS = { "icons/claude.svg": "mods/spaces-md/icons/claude.svg" };
function programIcon(p, size, color) {
  if (!p?.icon) return null;
  const fixed = FIXED_ICONS[p.icon];
  if (fixed) return image(fixed).w(size).h(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// A repo's name from its git folder: the folder holding .git, a bare repo's own
// name, or the folder holding a hidden bare repo (<project>/.bare).
const repoName = (common) => {
  if (common.endsWith("/.git")) return base(common.slice(0, -5));
  const own = base(common);
  return own === ".bare" ? base(common.slice(0, -own.length - 1)) : own.replace(/\.git$/, "");
};
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// Keep the whole leading emoji in the avatar (same rule in spaces and picker).
// Newer pictographs such as 🖥 may be drawn as emoji without VS16. A trailing
// selector, modifier or joiner can signal that we matched only part of a glyph.
const EMOJI = /^(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|(?:\p{Emoji_Presentation}|(?=[\u{1F000}-\u{1FFFF}])\p{Extended_Pictographic}|\p{Extended_Pictographic}(?=\uFE0F)|\p{Emoji_Modifier_Base}(?=\p{Emoji_Modifier}))\uFE0F?[\p{Emoji_Modifier}\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)(?![\p{Grapheme_Extend}\p{Emoji_Modifier}\u200D])/u;
function spaceAvatar(name) {
  return EMOJI.exec(name)?.[0] ?? ([...name][0]?.toUpperCase() ?? "?");
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// Added: moving an agent to another space by dragging. A drag source (a tab in tabs-md, a row in
// agents-md, an icon on this rail) puts { tab, space, machine, source, at } in shared "agent.drag"
// once the pointer has moved DRAG_PX with the button held, and clears it shortly after release.
// This list is the drop target and does the move (moveTab): the space under the pointer (same
// machine, not the tab's own) is outlined, and a "New space" row appears at the end.
const DRAG_PX = 10;
const DROP_AFTER_MS = 250; // a drop this soon after the drag began is a sloppy click, not a move
const DRAG_CLEAR_MS = 300; // the source clears the drag this long after release, so the target reads it first
const dragNow = () => { const d = shared("agent.drag"); return d && typeof d.tab === "string" ? d : null; };
const canDrop = (d, w) => Boolean(d) && w.id !== d.space && (w.machine ?? null) === (d.machine ?? null);
const inside = (p, b) => Boolean(p && b) && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
function dragPayload(tab, source) {
  const s = spaces().find((x) => (x.tabs ?? []).some((c) => c.id === tab));
  return s ? { tab, space: s.id, machine: s.machine ?? null, source, at: Date.now() } : null;
}
// Polls `test` every 50 ms until it's true or `ms` have passed.
async function until(cx, test, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await cx.sleep(50)) if (test()) return true;
  return test();
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repoName(repo);
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      this.activeAt = rows.findIndex(r => r.w.active);
      return rows.map(draw);
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const items = [cell(head), ...guidance, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
      const first = folded ? -1 : mine.findIndex(r => r.w.active);
      if (first >= 0) this.activeAt = before + 1 + guidance.length + first;
      before += items.length;
      return items;
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one. When the row is full, it
  // and the name both start from their text's width and give way in proportion.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const fullName = name.toLowerCase();
    const emoji = EMOJI.exec(name)?.[0];
    const label = emoji ? name.slice(emoji.length).trim().toLowerCase() : fullName;
    const same = (a) => {
      const text = a.toLowerCase();
      return text === fullName || text === label;
    };
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(where ? SIDE_MIN : 0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // Added: the pointer is over a drop target (a space id or "new"); `bounds` (window pixels) lets a
  // later move outside it clear the target again.
  dropHover(target, e, cx) {
    if (!dragNow()) return;
    this.dropBounds = e.bounds;
    if (this.dropOver !== target) { this.dropOver = target; cx.notify(); }
  }

  // Added: window-wide pointer moves: start a drag from a rail icon, forget a target the pointer left.
  dragMove(e, cx) {
    const src = this.dragSrc;
    if (src) {
      if (e.pressed_button !== "left") { this.dragSrc = null; if (src.started) this.dragClear(src, cx); }
      else if (!src.started && Math.hypot(e.position.x - src.x, e.position.y - src.y) >= DRAG_PX) {
        const d = dragPayload(src.tab, "rail");
        if (d) { src.started = true; src.at = d.at; setShared("agent.drag", d); cx.notify(); }
      }
    }
    if (this.dropOver && !inside(e.position, this.dropBounds)) { this.dropOver = null; cx.notify(); }
  }

  dragClear(src, cx) {
    cx.timer.after(DRAG_CLEAR_MS, () => { if (shared("agent.drag")?.at === src.at) setShared("agent.drag", null); });
  }

  // Added: release anywhere in the window: drop on the target, if any; end a drag that started here.
  dragEnd(cx) {
    const d = dragNow(), target = this.dropOver;
    this.dropOver = null;
    const src = this.dragSrc;
    this.dragSrc = null;
    if (src?.started) { this.dragClear(src, cx); this.dragJustEnded = Date.now(); }
    if (d && target && Date.now() - d.at >= DROP_AFTER_MS) this.moveTab(d, target, cx);
    cx.notify();
  }

  // Added: moves a tab's terminals to another space (or a new one), running, with the tab's name.
  // Herdr has no move command: terminal.park takes a terminal's pane away (it keeps running), and
  // terminal.keep gives it a new tab in the shown space, named after the terminal; tab.rename then
  // puts the name back. A split tab's panes come back side by side, in order.
  moveTab(d, target, cx) {
    cx.spawn(async (cx) => {
      const from = spaces().find((s) => s.id === d.space);
      const tab = from?.tabs?.find((c) => c.id === d.tab);
      const moving = panes().filter((p) => p.tab === d.tab && p.terminal).map((p) => ({ terminal: p.terminal, name: p.name }));
      if (!tab || !moving.length) return;
      const gone = (m) => !panes().some((p) => p.terminal === m.terminal);
      const shown = (m) => panes().find((p) => p.terminal === m.terminal);
      try {
        for (const m of moving) run("terminal.park", { terminal: m.terminal });
        if (!(await until(cx, () => moving.every(gone)))) throw new Error("the panes didn't close");
        let space = target, placeholder = null;
        if (target === "new") {
          const known = new Set(spaces().map((s) => s.id));
          run("space.new", { machine: d.machine ?? "", focus: true });
          if (!(await until(cx, () => spaces().some((s) => !known.has(s.id) && s.tabs?.length)))) throw new Error("no new space");
          const made = spaces().find((s) => !known.has(s.id));
          space = made.id;
          await until(cx, () => panes().some((p) => p.tab === made.tabs[0].id && p.terminal));
          placeholder = panes().find((p) => p.tab === made.tabs[0].id && p.terminal)?.terminal ?? null;
        } else run("space.select", { id: target });
        if (!(await until(cx, () => spaces().find((s) => s.id === space)?.active))) throw new Error("the space didn't open");
        const [first, ...rest] = moving;
        run("terminal.keep", { terminal: first.terminal, place: "tab" });
        if (!(await until(cx, () => shown(first)?.tab))) throw new Error("the tab didn't appear");
        const newTab = shown(first).tab;
        for (const m of rest) {
          run("pane.focus", { pane: shown(rest[rest.indexOf(m) - 1] ?? first).pane });
          run("terminal.keep", { terminal: m.terminal, place: "right" });
          await until(cx, () => shown(m));
        }
        run("tab.rename", { id: newTab, name: tab.named ? tab.name : "" });
        for (const m of moving) if (m.name && shown(m)) run("pane.rename", { pane: shown(m).pane, name: m.name });
        run("pane.focus", { pane: shown(first).pane });
        // The new space's own first shell: once it's running, end it (its tab closes), so the space
        // holds just the moved tab and is named after where that is.
        if (placeholder && (await until(cx, () => terminals().some((x) => x.address === placeholder && x.state === "live"), 5000))) {
          await cx.sleep(300);
          run("terminal.kill", { terminal: placeholder });
        }
      } catch (err) {
        notify({ title: "Couldn't move the agent", body: `${String(err?.message ?? err)}. It's still running: ${moving.map((m) => m.terminal).join(", ")} (hc ls).`, level: "error" });
      }
    });
  }

  // Added: the "New space" drop row, shown only while an agent is dragged.
  newSpaceDrop(t, collapsed) {
    const over = this.dropOver === "new";
    const plus = svg("mods/workspace-chrome/plus.svg").size(collapsed ? 18 : 14).flex_none();
    const cell = collapsed
      ? railCell(h_flex().w(RAIL_BIG).h(RAIL_BIG).justify_center().items_center()
          .child(h_flex().size(BADGE).rounded(Math.round(BADGE / 4)).border(RING).border_dashed().justify_center().items_center()
            .border_color(over ? t.accent : t.border).text_color(over ? t.accent : t.dim).child(plus)))
      : h_flex().h(34).px(8).gap(9).flex_none().items_center().rounded(8).border_1().border_dashed()
          .border_color(over ? t.accent : t.border).text_color(over ? t.accent : t.dim).when(over, (el) => el.bg(t.hover))
          .child(plus).child("New space");
    return div().id("space-drop-new").mt(collapsed ? 0 : 4).on_mouse_move((e, cx) => this.dropHover("new", e, cx)).child(cell);
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      // Added: an agent dragged over this space: outlined, and dropping moves it here (the hover is
      // noticed in the one on_mouse_move below: a second one on the same element replaces the first).
      .when(this.dropOver === w.id, (el) => el.border_1().border_color(t.accent).bg(t.hover))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((e, cx) => {
        if (canDrop(dragNow(), w)) this.dropHover(w.id, e, cx); // Added
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child(spaceAvatar(w.name))))
          .child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  // Changed: on the rail each space is its coloured letter badge (as in the full sidebar, larger)
  // with its agents directly under it, joined by a line in the space's colour; the separate
  // agents list steps aside on the rail (chrome-md / tabs-md hide its block while folded).
  compact({ w, i }, t) {
    const mine = agents().filter((a) => a.space === w.id);
    const attention = w.status === "blocked" || w.status === "done";
    // The selected space gets a ring around its badge, with a small gap (no grey underlay);
    // the others reserve the same space so nothing shifts. Hover shows a faint ring.
    const ringed = h_flex().p(RING_GAP).border(RING).rounded(Math.round(BADGE / 4) + RING_GAP + RING)
      .border_color(this.dropOver === w.id ? t.accent : w.active ? (t.idle ?? t.dim) : t.chrome) // mid-dark grey ring: #8e8e93 (dark mode #98989d); Added: accent while an agent is dragged over it
      .when(!w.active, (el) => el.hover((s) => s.border_color(t.input)))
      .child(this.badge(w, t, BADGE));
    const head = h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_BIG)
      .h(RAIL_BIG)
      .justify_center()
      .items_center()
      .on_click((_e, cx) => { run("space.select", { id: w.id }); this.quietCard(`space-card-${w.id}`, cx); })
      .on_mouse_move((e, cx) => { if (canDrop(dragNow(), w)) this.dropHover(w.id, e, cx); }) // Added: drop target
      .child(ringed)
      .when(attention, (el) => el.child(
        div().absolute().top(3).right(3).size(14).rounded(7).border_2().border_color(t.chrome).bg(tone(t, w.status))
          .when(w.status === "blocked", (d) => d.loop("opacity", PULSE))));
    // The agents column is exactly as wide as the badge, so the space's colour line drops straight
    // down from the badge's left edge.
    // Space groups breathe: 10px above each badge, 14px below its agents.
    return railCell(v_flex().items_center().gap(4).pt(10).pb(mine.length ? 14 : 6)
      .child(this.card(`space-card-${w.id}`, head, this.spaceCard(w, mine, t)))
      .when(mine.length > 0, (el) => el.child(
        this.agentColumn(mine, w, t))));
  }

  // Hover cards. Anchored "left_center": the card sits directly right of its trigger, vertically
  // centred, so its hover area never covers the icons below (an earlier version offset the card
  // with margins, and that margin area caught clicks meant for the agents underneath).
  // After a click (quietCard, called from the click handlers, so the click itself is never
  // disturbed) that icon's card stays hidden until the pointer leaves it, as macOS does.
  quietCard(id, cx) {
    (this.quiet ??= new Set()).add(id);
    cx.notify();
  }

  card(id, trigger, content) {
    this.quiet ??= new Set();
    const watched = trigger.on_hover((hovered, cx) => { if (!hovered && this.quiet.delete(id)) cx.notify(); });
    if (this.quiet.has(id)) return watched;
    return HoverCard.new(id).open_delay(CARD_DELAY).close_delay(100).anchor("left_center").trigger(watched).content(content);
  }

  cardFrame(t) {
    return v_flex().ml(8).w(250).p(12).gap(6).rounded(10).bg(t.popover)
      .border_1().border_color(t.border).shadow_lg().text_size(12.5).text_color(t.foreground);
  }

  spaceCard(w, mine, t) {
    const n = spaces().findIndex((s) => s.id === w.id) + 1;
    return this.cardFrame(t)
      .child(h_flex().gap(8).items_center()
        .child(this.badge(w, t, 18))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13.5).child(w.name))
        .when(n >= 1 && n <= 9, (el) => el.child(div().px(6).py(1).rounded(5).bg(t.raised).border_1().border_color(t.border)
          .text_size(11).text_color(t.muted).child(`${SHORTCUT_PREFIX}${n}`))))
      .child(div().truncate().text_size(11.5).text_color(t.dim).child(`${w.machine ? w.machine + ": " : ""}${tilde(w.folder) || "~"}`))
      .child(mine.length
        ? v_flex().gap(4).pt(6).border_t(1).border_color(t.border).children(mine.map((a) => h_flex().gap(7).items_center()
            .child(programIcon(a.program, 14, t.foreground) ?? div())
            .child(div().flex_1().min_w(0).truncate().child(agentName(a)))
            .child(div().text_size(11.5).text_color(tone(t, a.status)).child(STATUS_TEXT[a.status] ?? a.status))))
        : div().text_size(11.5).text_color(t.dim).child("No agents"));
  }

  agentCard(a, w, t) {
    const cwd = panes().find((p) => p.pane === a.pane)?.cwd;
    return this.cardFrame(t)
      .child(h_flex().gap(8).items_center()
        .child(programIcon(a.program, 16, t.foreground) ?? div())
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13.5).child(agentName(a))))
      .child(h_flex().gap(6).items_center()
        .child(this.badge(w, t, 14))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(w.name))
        .child(div().text_size(11.5).text_color(tone(t, a.status)).child(STATUS_TEXT[a.status] ?? a.status)))
      .when(Boolean(cwd), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(cwd))));
  }

  // The space's colour line runs down its agents. One bar per space marks the active agent and
  // slides along the line when focus moves to another agent in the same space (native "top"
  // transition). When the active agent is in another space, this bar fades out where it is, and
  // the other space's bar fades in at its agent (it doesn't slide in from a stale spot).
  agentColumn(mine, w, t) {
    const fill = this.fill(w, t);
    const row = AGENT_CELL + 4;
    const index = mine.findIndex((a) => a.focused);
    const shown = index >= 0;
    this.barShown ??= new Map();
    const wasShown = this.barShown.get(w.id) ?? false;
    this.barShown.set(w.id, shown);
    const top = Math.max(0, index) * row + 5;
    const bar = div().id(`rail-bar-${w.id}`).absolute().left(0).w(ACTIVE_BAR).h(AGENT_CELL - 6).rounded(ACTIVE_BAR / 2).bg(fill)
      .opacity(shown ? 1 : 0).transition("opacity", { duration: 160, easing: "ease-out" })
      .when(shown, (el) => el.top(top))
      .when(shown && wasShown, (el) => el.transition("top", { duration: 220, easing: "ease-out" }));
    return v_flex().id(`rail-agents-${w.id}`).relative().w(BADGE)
      .children(mine.map((ag) => h_flex().w(BADGE).h(row).items_center().justify_end().child(this.railAgent(ag, w, t))))
      .child(div().absolute().left(0).top(0).bottom(0).w(RING).bg(fill))
      .child(bar);
  }

  railAgent(a, w, t) {
    const cell = h_flex()
      .id(`rail-ag-${a.address}`)
      .relative()
      .size(AGENT_CELL)
      .rounded(7)
      .justify_center()
      .items_center()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (Date.now() - (this.dragJustEnded ?? 0) < 200) return; // Added: the end of a drag isn't a click
        run("pane.focus", { pane: a.pane }); this.quietCard(`agent-card-${a.address}`, cx);
      })
      // Added: drag the icon onto another space to move the agent's tab there.
      .on_mouse_down("left", (e) => { this.dragSrc = { tab: a.tab, x: e.position.x, y: e.position.y, started: false }; })
      .when(this.dragSrc?.started && this.dragSrc.tab === a.tab, (el) => el.opacity(0.4))
      .child(programIcon(a.program, AGENT_ICON, t.foreground) ?? div().text_color(t.muted).child(String(agentName(a))[0] ?? "?"))
      .child(h_flex().absolute().bottom(0).right(0).min_w(15).h(15).px(1).rounded(8).bg(t.chrome)
        .items_center().justify_center().child(this.agentStatus(a, t)));
    return this.card(`agent-card-${a.address}`, cell, this.agentCard(a, w, t));
  }

  // The agents list's compact status: spinner, "!" (pulsing), ring, dot.
  agentStatus(a, t) {
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked") return div().size(13).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked)
      .flex().items_center().justify_center().child("!").loop("opacity", PULSE);
    if (a.status === "idle") return div().size(7).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).flex_none().rounded(4).bg(a.status === "done" ? (t.done ?? t.dim) : t.dim + "00");
  }

  fill(w, t) {
    const color = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
    return color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  }

  badge(w, t, size = 20) {
    return h_flex().size(size).flex_none().rounded(Math.round(size / 4)).bg(this.fill(w, t)).items_center().justify_center()
      .text_size(Math.round(size * 0.5)).font_bold().text_color("#ffffff").child(spaceAvatar(w.name));
  }

  render(cx) {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    // Added: while an agent is dragged, a "New space" drop row ends the list.
    const drag = dragNow();
    if (!drag) this.dropOver = null;
    if (drag) list.push(this.newSpaceDrop(t, collapsed));
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return fade(this, v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        // Added: agent drags (see moveTab).
        .on_window_mouse_move((e, cx) => this.dragMove(e, cx))
        .on_window_mouse_up("left", (_e, cx) => this.dragEnd(cx))
        .children(list)), cx);
  }
}
