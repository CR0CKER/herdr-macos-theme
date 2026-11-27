import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle, Popup } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, nextCommand, checking, props, setShared, focused, appHome, readTextFile, watchFolder } from "herdr";


function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// To the rail, or back to the width it had. Changed (macOS layouts):
// - the macOS rail is 108px, so the window buttons and the sidebar button both stay in the grey
//   header row, at the same place as when the sidebar is open; elsewhere 72px, which the rail's
//   60px space cells need;
// - the width slides over SLIDE_MS, one resize per frame (Herdr can't animate a layout size
//   natively), easing out. During the slide the sidebar's mods keep their open layout and move it
//   with the edge (their fade()), so nothing inside re-wraps per frame; as the edge settles (within
//   SETTLE_PX of the rail) the slide is marked settled and the rail takes over and fades in.
const RAIL_MAC = 108, RAIL = 72, SLIDE_MS = 180, SLIDE_STEPS = 12, SETTLE_PX = 12;
const railWidth = () => (window()?.platform === "macos" ? RAIL_MAC : RAIL);
function toggleSidebar(cx) {
  // A click during a slide counts from where that slide is heading, so an in-between width is
  // never remembered as the sidebar's open width.
  const slide = shared("sidebar.slide");
  const midSlide = slide && typeof slide.until === "number" && Date.now() < slide.until;
  const width = midSlide ? slide.to : (find(layout(), "sidebar")?.size?.px ?? 268);
  const from = find(layout(), "sidebar")?.size?.px ?? width;
  const wasNarrow = width < 160;
  const target = wasNarrow ? (shared("sidebar.width") ?? 268) : railWidth();
  const id = `${Date.now()}-${Math.random()}`;
  if (cx) setShared("sidebar.slide", { id, to: target, until: Date.now() + SLIDE_MS + 60 });
  if (!wasNarrow) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !wasNarrow);
  // On the rail the spaces list shows each space's agents (spaces-md), so the agents block steps
  // aside while folded: hidden as the fold settles, shown as soon as it unfolds.
  const agentsBlock = (show) => { if (find(layout(), "agents")) run(show ? "layout.show" : "layout.hide", { id: "agents" }); };
  if (wasNarrow) agentsBlock(true);
  if (!cx) { run("layout.resize", { id: "sidebar", px: target }); if (!wasNarrow) agentsBlock(false); return; }
  let settled = false;
  for (let i = 1; i <= SLIDE_STEPS; i++) {
    const p = i / SLIDE_STEPS, eased = 1 - Math.pow(1 - p, 3);
    const px = Math.round(from + (target - from) * eased);
    cx.timer.after(Math.round(SLIDE_MS * p), () => {
      const now = shared("sidebar.slide");
      if (now?.id !== id) return; // a newer click took over
      run("layout.resize", { id: "sidebar", px });
      // The record stays (marked settled), so a click now still counts from this slide's target.
      if (!settled && (i === SLIDE_STEPS || Math.abs(target - px) <= SETTLE_PX)) {
        settled = true;
        if (!wasNarrow) agentsBlock(false);
        setShared("sidebar.slide", { ...now, settled: true });
      }
      if (i === SLIDE_STEPS) setShared("sidebar.slide", null);
    });
  }
}

// Added: the side panel (Files, Changes) slides open and shut the same way: from a sliver to the
// width it had (shared "panel.width"), and back, then hidden. Shared "panel.slide" {id, open, until}
// lets files-md keep its open layout meanwhile, and a click mid-slide counts from that slide's width.
const PANEL_MIN = 1; // a sliver this thin, so hiding it at the end of a close shows no jump
function slidePanel(show, child, cx) {
  const node = find(layout(), "panel");
  if (!node) return;
  const slide = shared("panel.slide");
  const mid = slide && typeof slide.until === "number" && Date.now() < slide.until;
  const px = node.size?.px ?? 368;
  const open = mid ? slide.open : (node.hidden ? (shared("panel.width") ?? px) : px);
  if (!mid && !node.hidden) setShared("panel.width", px);
  if (child) run("layout.select", { stack: "panel-body", child });
  const from = node.hidden ? PANEL_MIN : px, to = show ? open : PANEL_MIN;
  const id = `${Date.now()}-${Math.random()}`;
  setShared("panel.slide", { id, open, show, until: Date.now() + SLIDE_MS + 60 });
  if (node.hidden) { run("layout.resize", { id: "panel", px: from }); run("layout.show", { id: "panel" }); }
  for (let i = 1; i <= SLIDE_STEPS; i++) {
    const p = i / SLIDE_STEPS, eased = 1 - Math.pow(1 - p, 3);
    const step = Math.round(from + (to - from) * eased);
    cx.timer.after(Math.round(SLIDE_MS * p), () => {
      if (shared("panel.slide")?.id !== id) return; // a newer click took over
      run("layout.resize", { id: "panel", px: step });
      if (i < SLIDE_STEPS) return;
      if (!show) { run("layout.hide", { id: "panel" }); run("layout.resize", { id: "panel", px: open }); }
      setShared("panel.slide", null);
    });
  }
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

// Added: extra tab bar buttons from other mods, listed in the user's own `tab-buttons.json` in
// Herdr's config folder (not part of this theme, so reinstalling keeps it):
//   [{ "mod": "my-mod", "label": "Do it", "icon": "mods/my-mod/icon.svg", "tooltip": "…" }]
// A click opens that mod as an invisible 1×1 window with props {terminal, pane, tab, space, cwd}
// of the focused terminal; the mod does its work and closes itself (`closeOverlay(props().overlay)`).
const BUTTONS_FILE = "tab-buttons.json";

function parseButtons(text) {
  try {
    const list = JSON.parse(text ?? "[]");
    return Array.isArray(list) ? list.filter(b => b && typeof b.mod === "string" && b.mod) : [];
  } catch { return []; }
}

function runButton(b) {
  const f = focused() ?? {};
  openOverlay({ mod: b.mod, kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 },
    props: { terminal: f.terminal ?? null, pane: f.pane ?? null, tab: f.tab ?? null, space: f.space ?? null, cwd: f.cwd ?? null } });
}

// Added: drag a tab out of the bar onto a space in the sidebar to move it there (spaces-md does
// the move). While the drag stays in the bar it's still a reorder. See spaces-md "agent.drag".
const DRAG_PX = 10, DRAG_CLEAR_MS = 300;

// Added: the dragged agent's picture follows the pointer, whatever the drag started from (this tab
// bar, the Agents list, the rail). This bar draws it for the whole drag: a Popup is painted above
// the whole window, not clipped to this bar, so one picture can cross the sidebar without a
// handover (two mods taking turns flashed at their border). It sits just below and right of the
// pointer, so the pointer stays over the space it's dropped on; "→ Space" once one is targeted.
const GHOST_ICONS = { "icons/claude.svg": "mods/spaces-md/icons/claude.svg" };
// `d`: what's dragged ({label, icon, tint}); `target`: where it would land, if anywhere.
function dragGhost(t, at, d, target) {
  if (!d || !at) return null;
  const pic = !d.icon ? null : GHOST_ICONS[d.icon] ? image(GHOST_ICONS[d.icon]).size(14) : d.tint ? svg(d.icon).size(14).text_color(t.muted) : image(d.icon).size(14);
  const pill = h_flex().h(29).px(10).gap(7).items_center().rounded(7).text_size(12.8)
    .bg(t.raised).border_1().border_color(target ? t.accent : t.border).shadow_lg().text_color(t.foreground).opacity(0.95)
    .when(Boolean(pic), (el) => el.child(pic))
    .child(div().max_w(170).truncate().child(d.label || "Agent"))
    .when(Boolean(target?.name), (el) => el.child(div().max_w(140).truncate().text_color(t.accent).child(`→ ${target.name}`)));
  // The Popup element itself is placed at the pointer (it would otherwise sit in the row layout).
  return Popup.new("agent-drag-ghost", div().size(1)).absolute().left(at.x + 14).top(at.y + 12).anchor("top_left").content(pill);
}
// Where to draw it: the pointer's spot against this bar while a drag is on (an agent drag, or
// `reordering` tabs within this bar), else null.
function ghostSpot(e, reordering) {
  return (shared("agent.drag") || reordering) && e.pressed_button === "left" ? e.local_position : null;
}

// Added: where a tab dropped before or after another lands (tab.move's 1-based index), or null
// when it stays put. `from`, `to`: 0-based places in the space.
function reorderIndex(from, to, after) {
  const place = after ? (from < to ? to : to + 1) : (from < to ? to - 1 : to);
  return place === from ? null : place + 1;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    // Added: key commands. `tabs-md.sidebar` (Cmd+B in keys.snippet.json) folds/unfolds the sidebar.
    if (cx && !checking()) cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "sidebar") toggleSidebar(cx);
      }
    });
    // Added: extra buttons (see BUTTONS_FILE); reread when the file changes.
    this.extraButtons = [];
    if (cx && !checking()) cx.spawn(async (cx) => {
      const file = `${appHome()}/${BUTTONS_FILE}`;
      for (;;) {
        this.extraButtons = parseButtons(await readTextFile(file).catch(() => null));
        cx.notify();
        let batch;
        do batch = await watchFolder(appHome());
        while (batch.length && !batch.some(p => p === file || p === appHome() || p === `${appHome()}/`));
      }
    });
  }

  // Added: ends an agent drag shortly after release, so the drop target reads it first.
  dragClear(src, cx) {
    cx.timer.after(DRAG_CLEAR_MS, () => { if (shared("agent.drag")?.at === src.at) setShared("agent.drag", null); });
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    // Added: props.surface puts the bar on the layout's card (the macOS layouts), else chrome.
    const bar = props()?.surface ? t.surface : t.chrome;
    // Added: while the sidebar is the rail (narrower than 160px), the tab bar shows its button.
    const sidebarNode = find(layout(), "sidebar");
    const railed = Boolean(sidebarNode) && !sidebarNode.hidden && (sidebarNode.size?.px ?? Infinity) < 160
      && find(layout(), "brand")?.content?.mod !== "chrome-md"; // chrome-md keeps its own button on the rail
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      const over = this.overTab?.i === i && this.dragSrc?.reordering && this.dragSrc.tab !== c.id; // Added
      return h_flex().id(`tab-${c.id}`).relative().h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : bar).bg(c.active ? t.raised : bar).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation(); this.pressed = i;
          this.dragSrc = { tab: c.id, x: e.position.x, y: e.position.y, started: false, label: name, program }; // Added
          if (e.click_count === 2) run("tab.rename", { id: c.id });
        })
        .when((this.dragSrc?.started || this.dragSrc?.reordering) && this.dragSrc.tab === c.id, (el) => el.opacity(0.4)) // Added: being moved
        // Added: reordering: the tab under the pointer says which side the dragged one lands on.
        .on_mouse_move((e, cx) => {
          if (!this.dragSrc?.reordering) return;
          const after = e.local_position.x > e.bounds.width / 2;
          if (this.overTab?.i !== i || this.overTab.after !== after) { this.overTab = { i, after }; cx.notify(); }
        })
        .when(over, (el) => el.child(div().absolute().top(3).bottom(3).w(2).rounded(1).bg(t.accent)
          .when(this.overTab.after, (d) => d.right(-3)).when(!this.overTab.after, (d) => d.left(-3))))
        .on_mouse_up("left", () => {
          if (this.dragSrc?.started || this.dragSrc?.reordering) return; // Added: drags end in on_window_mouse_up
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : bar).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        // Changed: the panel slides open and shut (slidePanel); switching between Files and Changes
        // while it's open stays instant.
        .on_click((_e, cx) => {
          const slide = shared("panel.slide");
          const closing = slide && !slide.show && Date.now() < slide.until;
          if (on && !closing) slidePanel(false, null, cx);
          else if (panel && !panel.hidden && !closing) run("layout.select", { stack: "panel-body", child: id });
          else slidePanel(true, id, cx);
        }).child(svg(icon).size(14)).child(label);
    };
    // On the card (props.surface) the bar has no fill of its own, so the card's rounded corners show.
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().when(!props()?.surface, el => el.bg(bar)).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .relative() // Added: the drag ghost's spot is placed against the bar
      .when(Boolean(this.ghostAt && shared("agent.drag")), (el) => el.child(dragGhost(t, this.ghostAt, shared("agent.drag"), shared("agent.dropTarget"))))
      .when(Boolean(this.ghostAt && !shared("agent.drag") && this.dragSrc?.reordering), (el) => el.child(dragGhost(t, this.ghostAt,
        { label: this.dragSrc.label, icon: this.dragSrc.program?.icon ?? null, tint: Boolean(this.dragSrc.program?.tint) }, null)))
      // Added: a tab pressed and dragged out of the bar becomes an agent drag ("agent.drag").
      .on_window_mouse_move((e, cx) => {
        const at = ghostSpot(e, this.dragSrc?.reordering); // Added: the drag's picture follows
        if (at || this.ghostAt) { this.ghostAt = at; cx.notify(); }
        const src = this.dragSrc;
        if (!src) return;
        if (e.pressed_button !== "left") { this.dragSrc = null; if (src.started) this.dragClear(src, cx); cx.notify(); return; }
        const y = e.local_position.y, out = y < 0 || y > e.bounds.height;
        // Added: within the bar, a press moved DRAG_PX reorders tabs (see reorderIndex).
        if (!src.started && !out && !src.reordering && Math.hypot(e.position.x - src.x, e.position.y - src.y) >= DRAG_PX) {
          src.reordering = true; this.overTab = null; cx.notify();
        }
        if (!src.started && out && src.reordering) { src.reordering = false; this.overTab = null; cx.notify(); }
        if (!src.started && out && Math.hypot(e.position.x - src.x, e.position.y - src.y) >= DRAG_PX) {
          const s = spaces().find((x) => (x.tabs ?? []).some((c) => c.id === src.tab));
          if (!s) return;
          src.started = true; src.at = Date.now(); this.pressed = null;
          setShared("agent.drag", { tab: src.tab, space: s.id, machine: s.machine ?? null, source: "tabs", at: src.at,
            label: src.label, icon: src.program?.icon ?? null, tint: Boolean(src.program?.tint) });
          cx.notify();
        }
      })
      .on_window_mouse_up("left", (_e, cx) => {
        if (this.ghostAt) { this.ghostAt = null; cx.notify(); }
        const src = this.dragSrc;
        if (!src) return;
        cx.timer.after(0, (cx) => { if (this.dragSrc === src) this.dragSrc = null; cx.notify(); });
        if (src.started) this.dragClear(src, cx);
        // Added: a reorder within the bar lands before or after the tab last under the pointer.
        const over = this.overTab;
        this.overTab = null;
        if (src.reordering && over && shown[over.i]) {
          const from = space.tabs.findIndex((x) => x.id === src.tab), to = space.tabs.findIndex((x) => x.id === shown[over.i].id);
          const index = from < 0 || to < 0 ? null : reorderIndex(from, to, over.after);
          if (index) run("tab.move", { id: src.tab, index });
        }
        this.pressed = null;
      })
      .on_scroll_wheel(e => this.wheel(e))
      .when(railed, el => el.child(div().id("sidebar-show").size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => toggleSidebar(cx)).tooltip("Show sidebar (⌘B)")
        .child(svg("mods/workspace-chrome/sidebar.svg").size(18))))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().mode("scrolling").track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .children((this.extraButtons ?? []).map((b, i) => h_flex().id(`extra-${i}-${b.mod}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(bar).text_color(t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click(() => runButton(b))
        .when(typeof b.tooltip === "string" && b.tooltip, el => el.tooltip(b.tooltip))
        .when(typeof b.icon === "string" && b.icon, el => el.child(svg(b.icon).size(14)))
        .when(typeof b.label === "string" && b.label, el => el.child(b.label))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-md/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-md/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-md/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
