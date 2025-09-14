#!/usr/bin/env python3
"""
Generate a clean swimlane interaction diagram as a vector PDF.

- Vertical swimlanes: Frontend | Cloudflare Edge | Worker (Edge) | OS Places API
- Horizontal arrows only, in top-down order
- Labels inside rounded white boxes with keylines
- Outputs a vector PDF (infinitely zoomable)

Usage:
  python postcode_flow_diagram.py
  # Optional:
  python postcode_flow_diagram.py --width 40 --height 28 --title_font 16 --label_font 12 --wrap 50 --output postcode-flow.pdf
"""

import argparse
from textwrap import fill
import matplotlib
import matplotlib.pyplot as plt

# Ensure vector output
matplotlib.use("pdf")

def build_diagram(width=40, height=28, title_font=16, label_font=12, wrap=50, output="postcode-flow.pdf"):
    fig, ax = plt.subplots(figsize=(width, height))
    ax.set_axis_off()

    # Lane x positions
    x_client = 0.10
    x_edge   = 0.37
    x_worker = 0.65
    x_os     = 0.90

    lanes = [
        (x_client, "Frontend"),
        (x_edge,   "Cloudflare Edge"),
        (x_worker, "Worker (Edge)"),
        (x_os,     "OS Places API"),
    ]

    # Draw lanes + titles
    for x, label in lanes:
        ax.plot([x, x], [0.02, 0.98], linestyle=(0, (6, 6)), linewidth=1.5, color='black')
        ax.text(x, 0.99, label, ha='center', va='top', fontsize=title_font, fontweight='bold')

    def box_text(x, y, text):
        tx = fill(text, width=wrap)
        ax.text(
            x, y, tx, ha='center', va='center', fontsize=label_font,
            bbox=dict(boxstyle="round,pad=0.3,rounding_size=0.15", facecolor='white', edgecolor='black', linewidth=1)
        )

    def arrow(x0, x1, y, text):
        ax.annotate(
            "",
            xy=(x1, y),
            xytext=(x0, y),
            arrowprops=dict(arrowstyle="-|>", lw=2.5, color='black', mutation_scale=15)
        )
        box_text((x0 + x1) / 2.0, y - 0.006, text)

    # Vertical positions
    ys = iter([
        0.96, 0.93, 0.90, 0.87, 0.84,
        0.80, 0.76, 0.72, 0.68, 0.64,
        0.60, 0.56, 0.52, 0.48, 0.44,
        0.40, 0.36, 0.32, 0.28, 0.24,
        0.20, 0.16, 0.12, 0.08
    ])


    # Sequence steps
    y = next(ys); arrow(x_client, x_edge, y, "GET /api/address-lookup?pc=CB97XU&dataset=LPI&maxresults=100")

    # ── Security stack at Edge (before Access) ─────────────────────────────────────
    y = next(ys); box_text(x_edge, y, "WAF / Bot evaluation\nSkip via custom rule when CF-Access headers present")

    # If WAF/Bot blocks
    y = next(ys); arrow(x_edge, x_client, y, "If blocked → 403 Cloudflare challenge page")

    # ── Cloudflare Access (Service Token) ──────────────────────────────────────────
    y = next(ys); box_text(x_edge, y, "Access policy: Action = Service Auth\nValidate CF-Access-Client-Id/Secret (service token)")

    # If Access fails
    y = next(ys); arrow(x_edge, x_client, y, "If missing/invalid → 302 to /cdn-cgi/access/login")

    # If Access succeeds, invoke Worker
    y = next(ys); arrow(x_edge, x_worker, y, "Service Auth OK → Route match /api/address-lookup/* (invoke Worker)")

    # ── Worker flow ────────────────────────────────────────────────────────────────
    y = next(ys); arrow(x_client, x_worker, y, "OPTIONS preflight (CORS) → 204 No Content")
    y = next(ys); box_text(x_worker, y, "Validate OS_PLACES_KEY • Parse + normalise postcode • Strict regex validation")
    y = next(ys); box_text(x_worker, y, "Build cache key (pc/dataset/max + allow-list hash)\nCanonicalise path with trailing '/'")
    y = next(ys); arrow(x_worker, x_edge, y, "Edge cache lookup (caches.default.match)")
    y = next(ys); arrow(x_edge, x_client, y, "If HIT → 200 JSON (filtered)\nHeaders: x-edge-cache: HIT, x-allowlist-hash, server-timing")
    y = next(ys); box_text(x_worker, y, "MISS → Build OS URL\nfq: LOGICAL_STATUS_CODE:1; LPI_LOGICAL_STATUS_CODE:1\npostal=1 → POSTAL_ADDRESS_CODE:(D L)")
    y = next(ys); arrow(x_worker, x_os, y, "GET /search/places/v1/postcode")
    y = next(ys); arrow(x_os, x_worker, y, "200 OK → Full JSON payload")
    y = next(ys); box_text(x_worker, y, "Filter allow-list (CLASSIFICATION_CODE)\nProject to Slim (LPI/DPA) • Add LSB_PROPERTY_TYPE")
    y = next(ys); arrow(x_worker, x_edge, y, "Store at edge (caches.default.put)")
    y = next(ys); arrow(x_edge, x_client, y, "200 JSON (filtered, slim)\nHeaders: x-edge-cache: MISS; cache-control: s-maxage; server-timing")

    # ── Error paths (auth/timeouts) ───────────────────────────────────────────────
    y = next(ys); arrow(x_os, x_worker, y, "401/403 (auth error)")
    y = next(ys); arrow(x_worker, x_edge, y, "Try STALE from edge cache")
    y = next(ys); arrow(x_edge, x_client, y, "Serve STALE 200 or 502 os_auth_failed")
    y = next(ys); arrow(x_worker, x_os, y, "Timeout/Other error on fetch")
    y = next(ys); arrow(x_worker, x_edge, y, "Try STALE from edge cache")
    y = next(ys); arrow(x_edge, x_client, y, "Serve STALE 200 or 504 os_timeout")

    fig.savefig(output, bbox_inches="tight")
    print(f"Saved: {output}")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--width", type=float, default=20.0, help="page width inches")
    p.add_argument("--height", type=float, default=14.0, help="page height inches")
    p.add_argument("--title_font", type=int, default=16, help="lane title font size")
    p.add_argument("--label_font", type=int, default=12, help="label font size")
    p.add_argument("--wrap", type=int, default=50, help="wrap width for labels")
    p.add_argument("--output", type=str, default="postcode-flow.pdf", help="output PDF name")
    args = p.parse_args()
    build_diagram(args.width, args.height, args.title_font, args.label_font, args.wrap, args.output)

if __name__ == "__main__":
    main()