#!/usr/bin/env python3
# NETRUN — build per-country DNS seed from pingproxies/public-dns-directory.
#
# Phase 2a (DATA ONLY): the runtime selection logic lives elsewhere; this
# script just produces a static, repo-bundled seed so nodes never reach out
# to an untrusted source at proxy-spawn time.
#
# Per-country resolvers MUST be geo-local non-anycast (residential-looking),
# NOT global public-DNS brands — proxying through Cloudflare/Google/Quad9
# from a "Polish residential IP" is as obvious as proxying through 1.1.1.1.
# Global brands are confined to the `global` fallback tier ONLY.
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

# Country is "thin" if fewer than this many resolvers survive filtering.
THIN_COUNTRY_THRESHOLD = 2

# Per-country uptime tiers (relaxes only if a country can't fill THRESHOLD).
COUNTRY_UPTIME_TIERS = (99.0, 95.0, 90.0)

# Continent uptime tiers (middle of country→continent→global cascade).
CONTINENT_UPTIME_TIERS = (95.0, 90.0)

# At most this many IPs per organization in the continent layer — so one AS
# outage doesn't take the whole continent down at once.
CONTINENT_PER_ORG_CAP = 2

# Global public-DNS brand blocklist (case-insensitive substring match against
# `organization`). Resolvers from these orgs are recognizable as datacenter
# DNS — the whole point of per-country geo-local DNS is to look like a
# residential ISP resolver, NOT like another big public anycast. Brands stay
# in the `global` tier as last-resort fallback only.
BRAND_BLOCKLIST = (
    "google",
    "cloudflare",
    "opendns",
    "cisco",            # Cisco OpenDNS
    "quad9",
    "adguard",
    "verisign",
    "neustar",
    "level 3",
    "lumen",
    "centurylink",
    "cleanbrowsing",
    "controld",
    "nextdns",
    "dns.watch",
    "comodo",
    "hurricane",        # Hurricane Electric (HE)
    "he.net",
)

# Anycast global fallback — hardcoded, NOT from upstream directory.
# Quad9 secure + Cisco OpenDNS. Both are widely-deployed multi-AS anycast,
# and survive country-level censorship better than 1.1.1.1 / 8.8.8.8 (which
# carriers in TR/RU/CN routinely intercept). These ARE recognizable brands —
# global tier is the conscious "give up on stealth" fallback.
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


def is_brand(r: dict) -> bool:
    org = (r.get("organization") or "").lower()
    if not org:
        return False
    return any(kw in org for kw in BRAND_BLOCKLIST)


def dnssec_validating(r: dict) -> bool:
    return bool((r.get("dnssec") or {}).get("validating"))


def score_key(r: dict) -> tuple:
    # Sort descending; higher is better. Tuple compared lexicographically.
    # Trusted-first removed: that priority pulled global anycast brands
    # (Google/Quad9/OpenDNS) into per-country lists, defeating the geo-local
    # stealth goal. DNSSEC-validating preferred for safety against DNS hijack.
    return (
        1 if dnssec_validating(r) else 0,
        uptime(r, "30d"),
        uptime(r, "90d"),
        uptime(r, "1y"),
        uptime(r, "24h"),
        1 if not r.get("anycast") else 0,  # mild tiebreak: prefer non-anycast
    )


def select_for_country(
    resolvers: list[dict],
    ip_version: int,
    cap: int,
) -> tuple[list[str], str]:
    """Return (ip_list, tier_label). Empty list ⇒ no local resolvers; node
    will cascade to continent/global at selection time."""
    pool = [
        r for r in resolvers
        if r.get("version") == ip_version and not is_brand(r)
    ]
    if not pool:
        return [], "empty"

    for min_uptime in COUNTRY_UPTIME_TIERS:
        survivors = [r for r in pool if uptime(r, "30d") >= min_uptime]
        if len(survivors) >= THIN_COUNTRY_THRESHOLD:
            survivors.sort(key=score_key, reverse=True)
            return [r["ip"] for r in survivors[:cap]], f"local+{int(min_uptime)}"

    # All uptime tiers exhausted but pool is non-empty — return what we have
    # (best by score) up to THRESHOLD-1, label as "local+weak".
    pool.sort(key=score_key, reverse=True)
    if pool:
        return [r["ip"] for r in pool[:cap]], "local+weak"
    return [], "empty"


def select_for_continent(
    resolvers: list[dict],
    ip_version: int,
    cap: int,
) -> list[str]:
    pool = [
        r for r in resolvers
        if r.get("version") == ip_version and not is_brand(r)
    ]
    survivors: list[dict] = []
    for min_uptime in CONTINENT_UPTIME_TIERS:
        survivors = [r for r in pool if uptime(r, "30d") >= min_uptime]
        if survivors:
            break
    if not survivors:
        survivors = pool
    survivors.sort(key=score_key, reverse=True)

    # Diversify by organization — at most CONTINENT_PER_ORG_CAP IPs per org.
    seen_org: dict[str, int] = {}
    picked: list[str] = []
    for r in survivors:
        org = (r.get("organization") or "").strip().lower() or "_unknown"
        if seen_org.get(org, 0) >= CONTINENT_PER_ORG_CAP:
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
    no_local_v4: list[str] = []      # countries falling through to continent/global
    weak_v4: list[tuple[str, str]] = []   # countries with degraded tier (local+weak)
    for cc, pool in sorted(by_country.items()):
        v4, t4 = select_for_country(pool, 4, PER_COUNTRY_V4)
        v6, t6 = select_for_country(pool, 6, PER_COUNTRY_V6)
        countries_out[cc] = {"v4": v4, "v6": v6}
        if not v4:
            no_local_v4.append(cc)
        elif t4 == "local+weak":
            weak_v4.append((cc, t4))

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
            "thin_country_threshold": THIN_COUNTRY_THRESHOLD,
            "selection": "non-brand orgs only; uptime_30d cascade 99→95→90; "
                         "prefer DNSSEC validating, then uptime windows; "
                         "global anycast brands confined to `global` tier",
            "brand_blocklist": list(BRAND_BLOCKLIST),
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
        "countries_no_local_v4": no_local_v4,
        "countries_weak_v4": weak_v4,
        "continents_present": len(continents_out),
        "total_v4_picked": sum(len(c["v4"]) for c in countries_out.values()),
        "total_v6_picked": sum(len(c["v6"]) for c in countries_out.values()),
    }
    return seed, stats


def _resolver_index(directory: dict) -> dict[str, dict]:
    """Map IP → resolver record, for orgs/uptime annotation in reports."""
    return {r["ip"]: r for r in directory.get("resolvers", []) if r.get("ip")}


def print_coverage(seed: dict, stats: dict, directory: dict, out_path: str) -> None:
    idx = _resolver_index(directory)

    print()
    print("=" * 78)
    print("  NETRUN DNS seed — coverage report")
    print("=" * 78)
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
    print(f"  countries no-local  : {len(stats['countries_no_local_v4'])}"
          f"  (fall through to continent/global)")
    print(f"  countries weak v4   : {len(stats['countries_weak_v4'])}"
          f"  (uptime < 90% — degraded)")
    print()

    print("  --- Sold geos (each resolver with its org) ---------------------------------")
    for cc in SOLD_GEOS:
        rec = seed["countries"].get(cc, {"v4": [], "v6": []})
        v4 = rec["v4"]
        v6 = rec["v6"]
        print(f"  [{cc}]  v4={len(v4)}  v6={len(v6)}")
        for ip in v4:
            r = idx.get(ip, {})
            org = r.get("organization") or "(?)"
            up30 = uptime(r, "30d")
            dnssec = "DNSSEC" if dnssec_validating(r) else "      "
            print(f"        {ip:<18} {dnssec}  up30d={up30:6.2f}%  {org}")
        if not v4:
            print("        (no local v4 — uses continent/global fallback)")
        if v6:
            for ip in v6:
                r = idx.get(ip, {})
                print(f"        {ip:<24}  {r.get('organization') or '(?)'}")
    print()

    print("  --- Continents -------------------------------------------------------------")
    print("  KC    v4   v6")
    print("  ----  ---  ---")
    for kc, rec in sorted(seed["continents"].items()):
        print(f"  {kc:<4}  {len(rec['v4']):>3}  {len(rec['v6']):>3}")
    print()

    if stats["countries_no_local_v4"]:
        print("  --- Countries with NO local v4 (cascade to continent/global) --------------")
        # Wrap output for readability.
        ccs = stats["countries_no_local_v4"]
        for i in range(0, len(ccs), 20):
            print("    " + " ".join(ccs[i:i+20]))
        print()

    print(f"  output              : {out_path}")
    try:
        size = os.path.getsize(out_path)
        print(f"  seed.json size      : {size:,} bytes ({size / 1024:.1f} KB)")
    except OSError:
        pass
    print("=" * 78)


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(here, "seed.json")

    directory = fetch_resolvers()
    seed, stats = build_seed(directory)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    print_coverage(seed, stats, directory, out_path)

    missing_sold = [cc for cc in SOLD_GEOS if not seed["countries"].get(cc, {}).get("v4")]
    if missing_sold:
        print(f"\n[WARN] sold geos with ZERO v4 resolvers: {missing_sold}", file=sys.stderr)
    under_threshold_sold = [
        cc for cc in SOLD_GEOS
        if len(seed["countries"].get(cc, {}).get("v4", [])) < THIN_COUNTRY_THRESHOLD
    ]
    if under_threshold_sold:
        print(f"\n[WARN] sold geos with < {THIN_COUNTRY_THRESHOLD} local v4: "
              f"{under_threshold_sold}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
