"""Measurement freshness: fetching old device data never makes it current."""
from datetime import datetime

from heracles.storage import TZ, today


def fresh_metrics(health):
    if not health.get('account', {}).get('connected'):
        return {}
    values = {}
    for m in health.get('metrics', []):
        if m.get('status') != 'available' or m.get('value') is None or not m.get('fetched_at'):
            continue
        fetched = datetime.fromisoformat(m['fetched_at'])
        if (datetime.now(TZ) - fetched).total_seconds() > 3600:
            continue
        if m.get('source_at'):
            measured = datetime.fromisoformat(m['source_at'])
            max_age = 30 * 3600 if m['key'].startswith('sleep') else 3 * 3600
            if (datetime.now(TZ) - measured).total_seconds() > max_age:
                continue
        elif today().isoformat() not in m.get('detail', ''):
            # Untimestamped daily values need an explicit current device date.
            continue
        values[m['key']] = m['value']
    return values
