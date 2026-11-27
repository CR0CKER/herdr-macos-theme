import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";

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
export function toggleSidebar(cx) {
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

export default class WorkspaceChrome extends View {
  button(id, label, action, size = 26) {
    const t = theme();
    return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render(cx) {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, el => el.relative().w(40).h(34).px(0).justify_center().tooltip(label)) // Changed: larger on the rail
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/chrome-md/${icon}.svg`).size(collapsed ? 18 : 14))
        .when(!collapsed, el => el.child(label));
      const ready = div().size(6).rounded_full().bg(t.accent);
      const items = v_flex().size_full().when(collapsed, el => el.items_center())
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
      return fade(this, v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(items), cx);
    }
    // Changed: the sidebar button sits right after the macOS window buttons (as in Finder, Mail,
    // Notes), at macOS size, and stays exactly there when the sidebar folds to the rail. No app
    // title or icon (the window buttons and the toggle are the header, as in Finder and Mail);
    // search sits at the header's end, so during a slide it rides the sidebar's edge. Only it fades.
    const mac = window()?.platform === "macos" && !window()?.fullscreen;
    const toggle = this.button("sidebar-toggle", svg("mods/chrome-md/sidebar.svg").size(18), (_e, cx) => toggleSidebar(cx), 28)
      .tooltip(collapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)");
    const rest = h_flex().flex_1().min_w(0).gap(6).items_center().justify_end()
      .child(this.button("search", svg("mods/chrome-md/search.svg").size(16), () => run("mod.open", { name: "picker" }), 28).tooltip("Search (⌘P)"));
    return h_flex().size_full().bg(t.chrome).pl(14).pr(10).gap(6).items_center().text_size(13.5)
      .when(mac, el => el.pl(72))
      .when(collapsed, el => el.pr(4).when(!mac, el => el.pl(0).justify_center()))
      .child(toggle)
      .when(!collapsed, el => el.child(fade(this, rest, cx, false)));
  }
}
