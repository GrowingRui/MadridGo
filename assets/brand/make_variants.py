"""Generate MadridGo icon SVG variants from one definition of the mark.

Usage: python make_variants.py  (writes SVGs next to this file)
Rendering to PNG is a separate step (any SVG renderer, e.g. resvg).
"""

from pathlib import Path

BLUE = "#0B3A82"
AMBER = "#FFB31A"
WHITE = "#FFFFFF"
OUT = Path(__file__).parent


def mark(line: str = WHITE, signal: str = AMBER) -> str:
    """The symbol: an "M" drawn as a transit line with ring stops, plus a live signal.

    Stops are rings (not filled circles), so the background shows through the
    centre and the mark also works on transparent backgrounds.
    """
    return f"""
  <polyline points="272,664 272,336 512,600 752,336 752,664" fill="none" stroke="{line}"
            stroke-width="96" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="272" cy="744" r="52" fill="none" stroke="{line}" stroke-width="40"/>
  <circle cx="752" cy="744" r="52" fill="none" stroke="{line}" stroke-width="40"/>
  <circle cx="512" cy="248" r="44" fill="{signal}"/>
  <path d="M 432 200 A 92 92 0 0 1 592 200" fill="none" stroke="{signal}"
        stroke-width="26" stroke-linecap="round"/>
  <path d="M 384 156 A 152 152 0 0 1 640 156" fill="none" stroke="{signal}"
        stroke-width="26" stroke-linecap="round"/>"""


def svg(body: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" '
        f'width="1024" height="1024">\n  <title>MadridGo</title>{body}\n</svg>\n'
    )


# Android adaptive icons are cropped to various shapes; keep the mark inside the
# central safe zone (66/108 of the canvas). The mark's bounding-box centre is (512, 445).
SAFE = '\n  <g transform="translate(512 512) scale(0.66) translate(-512 -445)">{}\n  </g>'

variants = {
    # Master logo with rounded corners (MobilityLabs, website, documents).
    "madridgo-icon.svg": f'\n  <rect width="1024" height="1024" rx="224" fill="{BLUE}"/>{mark()}',
    # App-store icon: full-bleed square; iOS/Android apply their own corner mask.
    "app-icon.svg": f'\n  <rect width="1024" height="1024" fill="{BLUE}"/>{mark()}',
    # Android adaptive icon layers.
    "android-foreground.svg": SAFE.format(mark()),
    "android-background.svg": f'\n  <rect width="1024" height="1024" fill="{BLUE}"/>',
    "android-monochrome.svg": SAFE.format(mark(line=WHITE, signal=WHITE)),
}

if __name__ == "__main__":
    for name, body in variants.items():
        (OUT / name).write_text(svg(body), encoding="utf-8")
        print("wrote", name)
