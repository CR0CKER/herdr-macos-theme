"""Builds layouts/macos.json from Herdr's main layout (as cloned into main-md.json).

Slack-for-Mac structure, as in the Sable macOS theme: the window and sidebar share one grey,
and the work area is an inset card (4px gap, radius 12) holding the tab bar and terminals.
The status bar sits under the card on the grey window. The card has a hairline edge.
(A drop-shadow variant existed; Herdr's layout shadow draws flat grey bands
rather than a blur, so it was dropped.)
Usage: python3 -I tools/mklayout.py <base layout json> <output dir> [--force]
  e.g. python3 -I tools/mklayout.py tools/base/main-md.json layouts --force
"""
import copy
import json
import os
import sys


def find(node, id_):
    if node.get("id") == id_:
        return node
    for child in node.get("children", []):
        hit = find(child, id_)
        if hit:
            return hit
    return None


def build(base):
    root = copy.deepcopy(base)
    root.pop("cloned_from", None)
    root.pop("divider", None)  # sidebar and window are one grey surface
    root.update({
        "theme": {"light": "macos-light", "dark": "macos-dark"},
        "background": "canvas",
        "ui_font": ".SystemUIFont",
        "font": "Menlo",
        "preview": "layouts/macos.svg",
    })
    sidebar = find(root, "sidebar")
    sidebar["background"] = "chrome"

    work = find(root, "work")
    status = find(root, "status")
    work["children"] = [c for c in work["children"] if c.get("id") != "status"]
    # A hairline defines all four edges (no drop shadow: Herdr's is a flat band, not a blur).
    work.update({"background": "surface", "radius": 12, "border": {"width": 1, "color": "border"}})

    # Status bar on the grey window under the card, with no fill or top line (status-md, a copy of
    # workspace-status), so it doesn't cut off the card's shadow.
    status["content"] = {"mod": "status-md", "props": {"bare": True}}

    # Rail (collapsed sidebar) shows space badges and agent icons: spaces-md / agents-md, copies
    # of the shipped spaces / agents mods.
    find(root, "spaces")["content"] = {"mod": "spaces-md"}
    find(root, "agents")["content"] = {"mod": "agents-md"}
    # Sidebar header and footer: chrome-md (sidebar button next to the window buttons, fades).
    find(root, "brand")["content"] = {"mod": "chrome-md"}
    find(root, "sidebar-footer")["content"] = {"mod": "chrome-md", "props": {"footer": True}}

    tabs = find(root, "tabs")
    tabs["content"] = {"mod": "tabs-md", "props": {"surface": True}}

    body = find(root, "work-body")
    body.update({"padding": 6, "gap": 6})
    main = find(root, "main")
    pane = main["content"]["pane"]
    pane.update({
        "lone": False,  # a single pane sits directly on the card
        "radius": 8,
        "gap": 6,
        "background": "background",
        "border": {"width": 1, "color": "border"},
        "focus": {"width": 1, "color": "accent"},
    })

    frame = {
        "id": "work-frame",
        "type": "column",
        "padding": 4,
        "gap": 0,
        "resizable": False,
        "children": [work, status],
    }
    root["children"] = [frame if c.get("id") == "work" else c for c in root["children"]]
    return root


def main():
    args = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv
    if len(args) != 2:
        sys.exit(__doc__)
    base_path, out = args
    with open(base_path) as f:
        base = json.load(f)
    for name in ("macos",):
        path = os.path.join(out, f"{name}.json")
        if os.path.exists(path) and not force:
            sys.exit(f"{path} exists; pass --force to overwrite")
        with open(path, "w") as f:
            json.dump(build(base), f, indent=2)
            f.write("\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
