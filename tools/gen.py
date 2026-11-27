"""Generates Herdr's macOS light/dark theme files from the Sable macOS tokens.

Herdr theme files take #rrggbb only, so Sable's translucent colours are blended onto the
surface they sit on. ANSI colours start from Apple's system colours and are nudged darker
(light theme) or lighter (dark theme) only as far as needed to reach MIN contrast on the card.
Usage: python3 -I tools/gen.py <output dir>   (e.g. themes)
"""
import colorsys
import json
import os
import sys

MIN = 4.5


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def hexc(c):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v))) for v in c)


def blend(fg, alpha, bg):
    """fg at alpha over bg."""
    f, b = rgb(fg), rgb(bg)
    return hexc(tuple(f[i] * alpha + b[i] * (1 - alpha) for i in range(3)))


def lum(h):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(v) for v in rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def reach(color, bg, target=MIN):
    """Moves color's lightness away from bg until it reaches target contrast."""
    r, g, b = (v / 255 for v in rgb(color))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    darker = lum(bg) > 0.5
    for _ in range(200):
        c = hexc(tuple(v * 255 for v in colorsys.hls_to_rgb(h, l, s)))
        if contrast(c, bg) >= target:
            return c
        l = max(0.0, l - 0.005) if darker else min(1.0, l + 0.005)
    return c


def theme(light):
    if light:
        card, window, box = "#ffffff", "#ebebed", "#f2f2f4"
        ink, white = "#000000", "#ffffff"
        accent = "#007aff"
        t = {
            "canvas": window, "chrome": window, "surface": card,
            "popover": "#f6f6f8", "raised": box,
            "hover": blend(ink, 0.06, window),
            "selected": blend(ink, 0.10, window),  # neutral grey, like a Finder sidebar row
            "border": blend(ink, 0.12, card),
            "input": "#c7c7cc",
            "foreground": blend(ink, 0.85, card),
            "muted": blend(ink, 0.65, card),
            "dim": reach(blend(ink, 0.50, card), window),
            "accent": accent, "accent_foreground": white,
            "solid": "#1d1d1f", "solid_foreground": white,
            "working": reach(accent, window),
            "blocked": reach("#ff9500", window),
            "done": reach("#34c759", window),
            "idle": "#8e8e93", "unknown": "#8e8e93",
        }
        base = ["#1d1d1f", "#ff3b30", "#34c759", "#ffcc00", "#007aff", "#af52de", "#30b0c7", "#6e6e73"]
        bright = ["#8e8e93", "#ff453a", "#30d158", "#ffd60a", "#0a84ff", "#bf5af2", "#40c8e0", "#1d1d1f"]
        selection = blend(accent, 0.22, card)
    else:
        card, window, box = "#1e1e1f", "#29292b", "#2c2c2e"
        ink, white = "#ffffff", "#ffffff"
        accent = "#0a84ff"
        t = {
            "canvas": window, "chrome": window, "surface": card,
            "popover": "#28282a", "raised": box,
            "hover": blend(ink, 0.07, window),
            "selected": blend(ink, 0.12, window),
            "border": blend(ink, 0.10, card),
            "input": "#48484a",
            "foreground": blend(ink, 0.86, card),
            "muted": blend(ink, 0.70, card),
            "dim": reach(blend(ink, 0.55, card), window),
            "accent": accent, "accent_foreground": white,
            "solid": "#f5f5f7", "solid_foreground": "#1d1d1f",
            "working": reach("#4aa3ff", window),
            "blocked": reach("#ff9f0a", window),
            "done": reach("#30d158", window),
            "idle": "#98989d", "unknown": "#98989d",
        }
        base = ["#48484a", "#ff453a", "#30d158", "#ffd60a", "#0a84ff", "#bf5af2", "#64d2ff", "#d1d1d6"]
        bright = ["#8e8e93", "#ff6961", "#4ae07a", "#ffe55c", "#5eaeff", "#da8fff", "#9be3ff", "#ffffff"]
        selection = blend(accent, 0.35, card)
    # 1-6 and 8-14 must read on the card (8 is the grey many tools use for secondary text);
    # 0, 7 and 15 keep their conventional roles.
    ansi = [c if i in (0, 7) else reach(c, card) for i, c in enumerate(base)]
    ansi += [c if i == 7 else reach(c, card) for i, c in enumerate(bright)]
    return {
        "background": card,
        "foreground": t["foreground"],
        "selection": selection,
        "cursor": accent,
        "ansi": ansi,
        "colors": t,
    }


def report(name, th):
    card, window = th["background"], th["colors"]["canvas"]
    print(f"== {name}")
    for k in ("foreground", "muted", "dim", "working", "blocked", "done", "accent"):
        print(f"  {k:10} {th['colors'][k]}  card {contrast(th['colors'][k], card):5.2f}  window {contrast(th['colors'][k], window):5.2f}")
    for i, c in enumerate(th["ansi"]):
        print(f"  ansi{i:<2}     {c}  card {contrast(c, card):5.2f}")


def main():
    out = sys.argv[1]
    for name, light in (("macos-light", True), ("macos-dark", False)):
        th = theme(light)
        with open(os.path.join(out, f"{name}.json"), "w") as f:
            json.dump(th, f, indent=2)
            f.write("\n")
        report(name, th)


if __name__ == "__main__":
    main()
