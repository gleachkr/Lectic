#!/usr/bin/env python3

from __future__ import annotations

import argparse
import collections
import difflib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


COLORS = [
    "\033[34m",  # Blue
    "\033[32m",  # Green
    "\033[33m",  # Yellow
    "\033[31m",  # Red
    "\033[35m",  # Magenta
    "\033[36m",  # Cyan
]
RESET = "\033[0m"


def _now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _usage_path() -> Path:
    data = os.environ.get("LECTIC_DATA")
    if not data:
        raise RuntimeError(
            "LECTIC_DATA is not set. Run via 'lectic usage' or set "
            "LECTIC_DATA explicitly."
        )

    return Path(data) / "usage.json"


def _prices_path() -> Path:
    data = os.environ.get("LECTIC_DATA")
    if not data:
        raise RuntimeError(
            "LECTIC_DATA is not set. Run via 'lectic usage' or set "
            "LECTIC_DATA explicitly."
        )

    return Path(data) / "prices.json"


def _parse_int_env(name: str) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return 0

    try:
        return int(raw)
    except ValueError:
        return 0


def _load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"usage file must be a JSON object: {path}")

    return data


def _atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps(data, indent=2, sort_keys=True)
    tmp.write_text(payload + "\n", encoding="utf-8")
    os.replace(tmp, path)


@dataclass
class Tokens:
    input: int
    output: int
    cached: int

    @property
    def total(self) -> int:
        # cached tokens are a subset of input
        return self.input + self.output


def _bump_model(models: Dict[str, Any], model: str, inc: Tokens) -> None:
    entry: Dict[str, Any]

    raw = models.get(model)
    if isinstance(raw, dict):
        entry = raw
    else:
        entry = {}
        models[model] = entry

    entry["input_tokens"] = int(entry.get("input_tokens", 0)) + inc.input
    entry["output_tokens"] = int(entry.get("output_tokens", 0)) + inc.output
    entry["cached_tokens"] = int(entry.get("cached_tokens", 0)) + inc.cached
    entry["turns"] = int(entry.get("turns", 0)) + 1
    entry["updated_at"] = _now_iso_utc()


def _hour_bucket_iso(ts: Optional[datetime] = None) -> str:
    if ts is None:
        ts = datetime.now(timezone.utc)

    rounded = ts.replace(minute=0, second=0, microsecond=0)
    return rounded.isoformat()


def _bump_hour(
    hourly: Dict[str, Any],
    hour: str,
    model: str,
    inc: Tokens,
) -> None:
    raw = hourly.get(hour)
    if isinstance(raw, dict):
        hour_entry = raw
    else:
        hour_entry = {}
        hourly[hour] = hour_entry

    models_raw = hour_entry.setdefault("models", {})
    if not isinstance(models_raw, dict):
        raise ValueError("hourly entry has non-object 'models'")

    _bump_model(models_raw, model, inc)
    hour_entry["updated_at"] = _now_iso_utc()


def _record_hook_usage() -> int:
    model = os.environ.get("LECTIC_MODEL") or "unknown"

    inc = Tokens(
        input=_parse_int_env("TOKEN_USAGE_INPUT"),
        output=_parse_int_env("TOKEN_USAGE_OUTPUT"),
        cached=_parse_int_env("TOKEN_USAGE_CACHED"),
    )

    path = _usage_path()

    db = _load_json(path)

    hourly_raw = db.setdefault("hourly", {})
    if not isinstance(hourly_raw, dict):
        raise ValueError(f"usage file has non-object 'hourly': {path}")

    hour = _hour_bucket_iso()
    _bump_hour(hourly_raw, hour, model, inc)

    db["updated_at"] = _now_iso_utc()
    _atomic_write_json(path, db)

    return 0


def _refresh_prices() -> int:
    import urllib.request

    url = "https://www.llm-prices.com/current-v1.json"
    path = _prices_path()
    print(f"Refreshing prices from {url}...")
    try:
        with urllib.request.urlopen(url) as response:
            data = json.loads(response.read().decode("utf-8"))
            _atomic_write_json(path, data)
            print(f"Prices saved to {path}")
            return 0
    except Exception as e:
        print(f"Error refreshing prices: {e}", file=sys.stderr)
        return 1


def _fmt_int(n: int) -> str:
    return f"{n:,}"


def _fmt_money(amount: float) -> str:
    if amount == 0:
        return "$0.00"
    if amount < 0.01:
        return f"${amount:,.4f}"
    return f"${amount:,.2f}"


def _find_price(price_map: Dict[str, Any], model: str) -> Optional[Dict[str, float]]:
    """
    Find the price for a model, using exact match, normalized match,
    longest prefix match, or fuzzy matching.
    """
    if not price_map:
        return None

    if model in price_map:
        return price_map[model]

    def normalize(s: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

    norm_model = normalize(model)
    norm_keys = {normalize(k): k for k in price_map}

    # 1. Exact normalized match
    if norm_model in norm_keys:
        return price_map[norm_keys[norm_model]]

    # 2. Longest prefix match on normalized names
    best_match = None
    best_len = -1
    for norm_p_id, orig_p_id in norm_keys.items():
        if norm_model.startswith(norm_p_id) and len(norm_p_id) > best_len:
            best_match = orig_p_id
            best_len = len(norm_p_id)

    if best_match:
        return price_map[best_match]

    # 3. Fuzzy matching as a last resort
    close_matches = difflib.get_close_matches(
        norm_model, norm_keys.keys(), n=1, cutoff=0.6
    )
    if close_matches:
        return price_map[norm_keys[close_matches[0]]]

    return None


def _get_color(index: int) -> str:
    return COLORS[index % len(COLORS)]


def _get_bucket_key(dt: datetime, granularity: str) -> str:
    if granularity == "hour":
        return dt.strftime("%Y-%m-%d %H:00")
    elif granularity == "day":
        return dt.strftime("%Y-%m-%d")
    elif granularity == "week":
        # ISO week date
        year, week, _ = dt.isocalendar()
        return f"{year}-W{week:02d}"
    elif granularity == "month":
        return dt.strftime("%Y-%m")
    return str(dt)


def _print_graph(
    db: Dict[str, Any],
    granularity: str,
    units: int,
    model_filter: Optional[str] = None,
    show_price: bool = False,
) -> int:
    hourly = db.get("hourly", {})
    if not isinstance(hourly, dict) or not hourly:
        print("No usage recorded.")
        return 0

    filter_re = None
    if model_filter:
        try:
            filter_re = re.compile(model_filter)
        except re.error as exc:
            raise ValueError(f"Invalid filter regex: {exc}") from exc

    price_map: Dict[str, Dict[str, float]] = {}
    if show_price:
        path = _prices_path()
        if not path.exists():
            print(
                "Warning: prices.json not found. Run with --refresh-prices "
                "to download it.",
                file=sys.stderr,
            )
        else:
            prices_data = _load_json(path)
            for item in prices_data.get("prices", []):
                p_id = item.get("id")
                if not p_id:
                    continue
                price_map[p_id] = {
                    "input": float(item.get("input", 0) or 0),
                    "output": float(item.get("output", 0) or 0),
                    "input_cached": float(
                        item.get("input_cached")
                        if item.get("input_cached") is not None
                        else item.get("input", 0) or 0
                    ),
                }

    buckets: Dict[str, Dict[str, Tokens]] = collections.defaultdict(
        lambda: collections.defaultdict(lambda: Tokens(0, 0, 0))
    )

    # If showing price, we also want to track costs in the same structure
    # but we'll use a float for the values.
    costs: Dict[str, Dict[str, float]] = collections.defaultdict(
        lambda: collections.defaultdict(float)
    )
    # We'll also need sub-costs for the stacked bar
    sub_costs: Dict[str, Dict[str, Dict[str, float]]] = collections.defaultdict(
        lambda: collections.defaultdict(lambda: {"input": 0.0, "output": 0.0, "cached": 0.0})
    )

    for time_str, data in hourly.items():
        if not isinstance(data, dict):
            continue
        try:
            dt = datetime.fromisoformat(time_str)
        except ValueError:
            continue

        key = _get_bucket_key(dt, granularity)
        models = data.get("models", {})
        if not isinstance(models, dict):
            continue

        for model, usage in models.items():
            if not isinstance(usage, dict):
                continue

            if filter_re and not filter_re.search(model):
                continue

            t_inc = Tokens(
                input=int(usage.get("input_tokens", 0)),
                output=int(usage.get("output_tokens", 0)),
                cached=int(usage.get("cached_tokens", 0)),
            )

            current = buckets[key][model]
            current.input += t_inc.input
            current.output += t_inc.output
            current.cached += t_inc.cached

            if show_price:
                p = _find_price(price_map, model)
                if p:
                    uncached = t_inc.input - t_inc.cached
                    c_in = (uncached * p["input"]) / 1_000_000
                    c_cached = (t_inc.cached * p["input_cached"]) / 1_000_000
                    c_out = (t_inc.output * p["output"]) / 1_000_000
                    
                    costs[key][model] += (c_in + c_cached + c_out)
                    sub_costs[key][model]["input"] += c_in
                    sub_costs[key][model]["cached"] += c_cached
                    sub_costs[key][model]["output"] += c_out
                else:
                    # Model not found in price map, remains 0.0
                    pass

    sorted_keys = sorted(buckets.keys())
    if units > 0:
        sorted_keys = sorted_keys[-units:]

    if not sorted_keys:
        print("No data in range.")
        return 0

    # Calculate scaling
    max_total = 0.0
    all_models = set()
    for key in sorted_keys:
        if show_price:
            models_cost = costs[key]
            total = sum(models_cost.values())
            all_models.update(models_cost.keys())
        else:
            models_usage = buckets[key]
            total = float(sum(t.total for t in models_usage.values()))
            all_models.update(models_usage.keys())
        
        if total > max_total:
            max_total = total

    sorted_models = sorted(list(all_models))
    model_colors = {m: _get_color(i) for i, m in enumerate(sorted_models)}

    # Legend
    legend_items = []
    for m in sorted_models:
        color = model_colors[m]
        # Show the three shades in the legend for each model
        legend_items.append(f"{color}█▓░{RESET} {m}")
    print("Legend: " + "  ".join(legend_items))
    print("        " + "█▓░ Output/Input/Cache")
    print("─" * 78)

    width = 40
    for key in sorted_keys:
        bar_str = ""
        if show_price:
            models_cost = costs[key]
            total = sum(models_cost.values())
        else:
            models_usage = buckets[key]
            total = float(sum(t.total for t in models_usage.values()))

        if max_total > 0:
            bar_len = int((total / max_total) * width)
        else:
            bar_len = 0

        # Sort models to keep color order consistent in the bar
        for m in sorted_models:
            if show_price:
                val_cost = costs[key].get(m, 0.0)
                if val_cost == 0:
                    continue
                
                # Calculate segment length for this model
                model_seg_len = int((val_cost / total) * bar_len) if total > 0 else 0
                if model_seg_len == 0:
                    continue
                
                sc = sub_costs[key][m]
                out_len = int((sc["output"] / val_cost) * model_seg_len)
                cached_len = int((sc["cached"] / val_cost) * model_seg_len)
                inp_len = model_seg_len - out_len - cached_len
            else:
                val = buckets[key].get(m)
                if not val or val.total == 0:
                    continue

                # Calculate segment length for this model
                model_seg_len = int((val.total / total) * bar_len) if total > 0 else 0
                if model_seg_len == 0:
                    continue
                
                # Now distribute model_seg_len into output, input, cached
                out_len = int((val.output / val.total) * model_seg_len)
                cached_len = int((val.cached / val.total) * model_seg_len)
                inp_len = model_seg_len - out_len - cached_len
            
            color = model_colors[m]
            bar_str += f"{color}"
            bar_str += "█" * out_len
            bar_str += "▓" * inp_len
            bar_str += "░" * cached_len
            bar_str += f"{RESET}"

        total_fmt = _fmt_money(total) if show_price else _fmt_int(int(total))
        print(f"{key:<16} │ {bar_str} {total_fmt}")

    print("─" * 78)
    return 0


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="lectic usage",
        description=(
            "Track and summarize Lectic token usage. "
            "Use --hook from an assistant_message hook to record usage."
        ),
    )
    parser.add_argument(
        "--hook",
        action="store_true",
        help=(
            "Record the current turn's token usage to $LECTIC_DATA/usage.json"
        ),
    )
    parser.add_argument(
        "-g",
        "--granularity",
        choices=["hour", "day", "week", "month"],
        default="day",
        help="Time granularity for the graph (default: day)",
    )
    parser.add_argument(
        "-u",
        "--units",
        type=int,
        default=14,
        help="Number of time units to show (default: 14)",
    )
    parser.add_argument(
        "-f",
        "--filter",
        help="Regex to filter models displayed in the graph",
    )
    parser.add_argument(
        "-p",
        "--price",
        action="store_true",
        help="Show usage in USD instead of tokens",
    )
    parser.add_argument(
        "--refresh-prices",
        action="store_true",
        help="Download fresh pricing data from llm-prices.com",
    )

    args = parser.parse_args(argv)

    try:
        if args.refresh_prices:
            return _refresh_prices()

        if args.hook:
            return _record_hook_usage()

        path = _usage_path()
        db = _load_json(path)
        return _print_graph(
            db,
            args.granularity,
            args.units,
            args.filter,
            show_price=args.price,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"lectic usage: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
