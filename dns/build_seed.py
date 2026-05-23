#!/usr/bin/env python3
# NETRUN — build per-country DNS seed from pingproxies/public-dns-directory.
#
# Phase 2a (DATA ONLY): the runtime selection logic lives elsewhere; this
# script just produces a static, repo-bundled seed so nodes never reach out
# to an untrusted source at proxy-spawn time.
#
# Run:  python dns/build_seed.py
# Out:  dns/seed.json + coverage stats to stdout.

from __future__ import annotations

import datetime as _dt
import json
import os
import sys
import urllib.error
import urllib.request

SOURCE_URLS = [
    "https://raw.githubusercontent.com/pingproxies/public-dns-directory/main/data/resolvers.json",
    "https://raw.githubusercontent.com/pingproxies/public-dns-directory/master/data/resolvers.json",
]

# How many resolvers to keep per geographic bucket.
PER_COUNTRY_V4 = 8
PER_COUNTRY_V6 = 4
PER_CONTINENT_V4 = 16
PER_CONTINENT_V6 = 8

# Country is "thin" if fewer than this many resolvers survive the strict filter.
THIN_COUNTRY_THRESHOLD = 2

# Cascading uptime thresholds: try strict first, relax for thin countries.
UPTIME_TIERS = (99.0, 95.0, 90.0, 0.0)

# Anycast global fallback — hardcoded, NOT from the upstream directory.
# Quad9 secure + OpenDNS. Both are widely trusted, multi-AS anycast,
# and survive country-level censorship better than 1.1.1.1 / 8.8.8.8
# (which carriers in TR/RU/CN routinely intercept).
GLOBAL_FALLBACK = {
    "v4": [
        "9.9.9.9",
        "149.112.112.112",
        "208.67.222.222",
        "208.67.220.220",
    ],
    "v6": [
        "2620:fe::fe",
        "2620:fe::9",
        "2620:119:35::35",
        "2620:119:53::53",
    ],
}

# Geos we currently sell — flagged separately in coverage report so a
# regression here is visible immediately.
SOLD_GEOS = ("US", "NL", "DE", "JP", "PL", "IN")


def fetch_resolvers() -> dict:
    last_err: Exception | None = None
    for url in SOURCE_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "netrun-build-seed/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"http {resp.status} from {url}")
                raw = resp.read()
            data = json.loads(raw)
            data["__source_url"] = url
            print(f"[fetch] OK {url} ({len(raw):,} bytes)", file=sys.stderr)
            return data
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as e:
            last_err = e
            print(f"[fetch] FAIL {url}: {e}", file=sys.stderr)
    raise SystemExit(f"all source URLs failed: {last_err}")


def uptime(r: dict, window: str) -> float:
    up = r.get("uptime") or {}
    val = up.get(window)
    if val is None:
        return 0.0
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def score_key(r: dict) -> tuple:
    # Sort descending; higher is better. Tuples compare lexicographically.
    return (
        1 if r.get("trusted") else 0,
        uptime(r, "30d"),
        uptime(r, "90d"),
        uptime(r, "1y"),
        uptime(r, "24h"),
    )


def passes_tier(r: dict, min_uptime: float, require_trusted: bool) -> bool:
    if require_trusted and not r.get("trusted"):
        return False
    return uptime(r, "30d") >= min_uptime


def select_for_country(
    resolvers: list[dict],
    ip_version: int,
    cap: int,
) -> tuple[list[str], str]:
    """Return (ip_list, tier_label_used). Empty list => country is thin."""
    pool = [r for r in resolvers if r.get("version") == ip_version]
    if not pool:
        return [], "empty"

    # Try tiers: (trusted, uptime>=99) → (trusted, uptime>=95) →
    #           (trusted, uptime>=90) → (any, uptime>=99) → (any, uptime>=95) → (any, anything)
    attempts = [
        (True, 99.0, "trusted+99"),
        (True, 95.0, "trusted+95"),
        (True, 90.0, "trusted+90"),
        (False, 99.0, "any+99"),
        (False, 95.0, "any+95"),
        (False, 0.0, "any"),
    ]
    for require_trusted, min_uptime, label in attempts:
        survivors = [r for r in pool if passes_tier(r, min_uptime, require_trusted)]
        if len(survivors) >= THIN_COUNTRY_THRESHOLD:
            survivors.sort(key=score_key, reverse=True)
            return [r["ip"] for r in survivors[:cap]], label
    # Last resort — anything in the pool, even 0% uptime, sorted by score.
    pool.sort(key=score_key, reverse=True)
    if pool:
        return [r["ip"] for r in pool[:cap]], "fallback"
    return [], "empty"


def select_for_continent(
    resolvers: list[dict],
    ip_version: int,
    cap: int,
) -> list[str]:
    # Continent is the middle tier of the country→continent→global cascade.
    # Don't gate on trusted=true here: upstream has only 13 trusted entries
    # globally, so a trusted-only filter starves AF/AS/SA continents to 0.
    # Sort by score_key (which still prefers trusted first), then uptime.
    pool = [
        r
        for r in resolvers
        if r.get("version") == ip_version and uptime(r, "30d") >= 95.0
    ]
    if not pool:
        # Relax to >=90% if 95% gate empties the continent (rare but possible
        # for small / under-monitored continents).
        pool = [r for r in resolvers if r.get("version") == ip_version and uptime(r, "30d") >= 90.0]
    pool.sort(key=score_key, reverse=True)
    # Diversify by organization — at most 2 IPs per org so a single AS outage
    # doesn't take the whole continent down at once.
    per_org_cap = 2
    seen_org: dict[str, int] = {}
    picked: list[str] = []
    for r in pool:
        org = (r.get("organization") or "").strip().lower() or "_unknown"
        if seen_org.get(org, 0) >= per_org_cap:
            continue
        seen_org[org] = seen_org.get(org, 0) + 1
        picked.append(r["ip"])
        if len(picked) >= cap:
            break
    return picked


def build_seed(directory: dict) -> tuple[dict, dict]:
    resolvers: list[dict] = directory.get("resolvers") or []

    by_country: dict[str, list[dict]] = {}
    by_continent: dict[str, list[dict]] = {}
    for r in resolvers:
        cc = (r.get("country_code") or "").upper()
        kc = (r.get("continent_code") or "").upper()
        if cc:
            by_country.setdefault(cc, []).append(r)
        if kc:
            by_continent.setdefault(kc, []).append(r)

    countries_out: dict[str, dict] = {}
    thin_countries: list[tuple[str, str, str]] = []  # (cc, v4_tier, v6_tier)
    for cc, pool in sorted(by_country.items()):
        v4, t4 = select_for_country(pool, 4, PER_COUNTRY_V4)
        v6, t6 = select_for_country(pool, 6, PER_COUNTRY_V6)
        countries_out[cc] = {"v4": v4, "v6": v6}
        if len(v4) < THIN_COUNTRY_THRESHOLD or t4 in ("any", "fallback", "empty"):
            thin_countries.append((cc, t4, t6))

    continents_out: dict[str, dict] = {}
    for kc, pool in sorted(by_continent.items()):
        continents_out[kc] = {
            "v4": select_for_continent(pool, 4, PER_CONTINENT_V4),
            "v6": select_for_continent(pool, 6, PER_CONTINENT_V6),
        }

    seed = {
        "version": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d"),
        "source": "pingproxies/public-dns-directory",
        "source_url": directory.get("__source_url", SOURCE_URLS[0]),
        "fetched_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "upstream_generated_at": (directory.get("metadata") or {}).get("generated_at"),
        "policy": {
            "per_country_v4": PER_COUNTRY_V4,
            "per_country_v6": PER_COUNTRY_V6,
            "per_continent_v4": PER_CONTINENT_V4,
            "per_continent_v6": PER_CONTINENT_V6,
            "preferred": "trusted=true AND uptime_30d>=99%, tiebreak uptime_90d/1y",
            "thin_country_threshold": THIN_COUNTRY_THRESHOLD,
        },
        "countries": countries_out,
        "continents": continents_out,
        "global": GLOBAL_FALLBACK,
    }
    stats = {
        "total_resolvers": len(resolvers),
        "countries_present": len(countries_out),
        "countries_with_v4": sum(1 for c in countries_out.values() if c["v4"]),
        "countries_with_v6": sum(1 for c in countries_out.values() if c["v6"]),
        "countries_thin": thin_countries,
        "continents_present": len(continents_out),
        "total_v4_picked": sum(len(c["v4"]) for c in countries_out.values()),
        "total_v6_picked": sum(len(c["v6"]) for c in countries_out.values()),
    }
    return seed, stats


def print_coverage(seed: dict, stats: dict, out_path: str) -> None:
    print()
    print("=" * 72)
    print(f"  NETRUN DNS seed — coverage report")
    print("=" * 72)
    print(f"  source              : {seed['source']}")
    print(f"  upstream generated  : {seed.get('upstream_generated_at') or 'n/a'}")
    print(f"  fetched_at          : {seed['fetched_at']}")
    print(f"  total resolvers in  : {stats['total_resolvers']:,}")
    print(f"  countries present   : {stats['countries_present']}")
    print(f"  countries w/ v4     : {stats['countries_with_v4']}")
    print(f"  countries w/ v6     : {stats['countries_with_v6']}")
    print(f"  continents present  : {stats['continents_present']}")
    print(f"  total v4 picked     : {stats['total_v4_picked']:,}")
    print(f"  total v6 picked     : {stats['total_v6_picked']:,}")
    print(f"  thin countries      : {len(stats['countries_thin'])}"
          f"  (fell back below trusted+30d>=99%)")
    print()
    print("  --- Sold geos -------------------------------------------------")
    print("  CC    v4   v6  | sample v4                  sample v6")
    print("  ----  ---  --- | -------------------------  ---------------------")
    for cc in SOLD_GEOS:
        rec = seed["countries"].get(cc, {"v4": [], "v6": []})
        v4 = rec["v4"]
        v6 = rec["v6"]
        sv4 = v4[0] if v4 else "(none)"
        sv6 = v6[0] if v6 else "(none)"
        print(f"  {cc:<4}  {len(v4):>3}  {len(v6):>3} | {sv4:<25}  {sv6}")
    print()
    print("  --- Continents ------------------------------------------------")
    print("  KC    v4   v6")
    print("  ----  ---  ---")
    for kc, rec in sorted(seed["continents"].items()):
        print(f"  {kc:<4}  {len(rec['v4']):>3}  {len(rec['v6']):>3}")
    print()
    print(f"  output              : {out_path}")
    try:
        size = os.path.getsize(out_path)
        print(f"  seed.json size      : {size:,} bytes ({size / 1024:.1f} KB)")
    except OSError:
        pass
    print("=" * 72)


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(here, "seed.json")

    directory = fetch_resolvers()
    seed, stats = build_seed(directory)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    print_coverage(seed, stats, out_path)

    missing_sold = [cc for cc in SOLD_GEOS if not seed["countries"].get(cc, {}).get("v4")]
    if missing_sold:
        print(f"\n[WARN] sold geos with ZERO v4 resolvers: {missing_sold}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
