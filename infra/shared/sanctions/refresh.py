#!/usr/bin/env python3
"""Refresh direct SDN-listed EVM addresses; no keys, tracing or exposure scoring."""
import argparse
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

SOURCE = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML'
HOSTS = {'sanctionslistservice.ofac.treas.gov', 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'}
NS = '{https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML}'
ADDRESS = re.compile(r'0x[0-9a-fA-F]{40}', re.IGNORECASE)
MAX_BYTES = 64 * 1024 * 1024
MAX_AGE = 86400


def checked_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.port not in (None, 443):
        raise ValueError('OFAC download redirected outside the approved HTTPS hosts')
    return url


class TreasuryRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return super().redirect_request(request, response, code, message, headers, checked_url(new_url))


def download():
    opener = urllib.request.build_opener(TreasuryRedirects())
    request = urllib.request.Request(SOURCE, headers={'User-Agent': 'Ophis-OFAC-refresh/1', 'Cache-Control': 'no-cache'})
    with opener.open(request, timeout=45) as response:
        checked_url(response.url)
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('OFAC export exceeds 64 MiB')
    return data


def extract(data):
    if len(data) > MAX_BYTES or b'<!DOCTYPE' in data or b'<!ENTITY' in data:
        raise ValueError('oversized export or forbidden XML declaration')
    events = ET.iterparse(io.BytesIO(data), events=('start', 'end'))
    _, root = next(events)
    if root.tag != NS + 'sdnList':
        raise ValueError('unexpected OFAC XML schema')
    addresses, entries, published, declared = set(), 0, None, None
    for event, element in events:
        if event != 'end':
            continue
        if element.tag == NS + 'Publish_Date':
            published = dt.datetime.strptime(element.text or '', '%m/%d/%Y').date()
        elif element.tag == NS + 'Record_Count':
            declared = int(element.text or '')
        elif element.tag == NS + 'sdnEntry':
            entries += 1
            for identifier in element.findall(f'{NS}idList/{NS}id'):
                kind = identifier.findtext(NS + 'idType', '')
                value = identifier.findtext(NS + 'idNumber', '').strip()
                if not kind.startswith('Digital Currency Address - '):
                    continue
                if ADDRESS.fullmatch(value):
                    addresses.add(value.lower())
                elif value.lower().startswith('0x') or kind.rsplit(' - ', 1)[-1] in {'ETH', 'ETC', 'ARB', 'BSC'}:
                    raise ValueError('malformed listed EVM address')
            root.clear()
    # shortcut: an intentionally empty OFAC address export requires operator review.
    if not addresses or entries != declared or not published or published > dt.datetime.now(dt.timezone.utc).date():
        raise ValueError('empty, incomplete or future-dated OFAC export')
    return {'published_at': published.isoformat(), 'entry_count': entries, 'addresses': sorted(addresses)}


def load(path, fresh=True):
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('oversized OFAC snapshot')
    snapshot = json.loads(path.read_text())
    fetched = snapshot['fetched_at']
    if type(fetched) is not int or fetched <= 0 or fetched > time.time():
        raise ValueError('invalid OFAC download timestamp')
    if fresh and time.time() - fetched > MAX_AGE:
        raise ValueError('OFAC download is older than 24 hours')
    addresses = snapshot['addresses']
    if not isinstance(addresses, list) or not addresses or any(not isinstance(a, str) or not ADDRESS.fullmatch(a) for a in addresses):
        raise ValueError('invalid OFAC address list')
    if snapshot['source_url'] != SOURCE or not re.fullmatch('[0-9a-f]{64}', snapshot['source_sha256']):
        raise ValueError('invalid OFAC provenance')
    dt.date.fromisoformat(snapshot['published_at'])
    return snapshot


def refresh(path):
    data = download()
    snapshot = {**extract(data), 'fetched_at': int(time.time()), 'source_url': SOURCE, 'source_sha256': hashlib.sha256(data).hexdigest()}
    path.parent.mkdir(parents=True, exist_ok=True)
    with (path.parent / '.refresh.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if path.exists():
            previous = load(path, fresh=False)
            if snapshot['published_at'] < previous['published_at'] or snapshot['fetched_at'] < previous['fetched_at']:
                raise ValueError('OFAC publication or download timestamp moved backwards')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                json.dump(snapshot, output, sort_keys=True)
                output.write('\n')
                output.flush()
                os.fchmod(output.fileno(), 0o644)
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
    print(f"OFAC refreshed: {len(snapshot['addresses'])} EVM addresses, published {snapshot['published_at']}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--once', action='store_true')
    mode.add_argument('--check', action='store_true')
    parser.add_argument('snapshot', type=Path)
    args = parser.parse_args()
    if args.check:
        load(args.snapshot)
        return
    while True:
        try:
            refresh(args.snapshot)
            delay = 900
        except Exception as error:
            print(f'OFAC refresh failed: {error}', file=sys.stderr, flush=True)
            if args.once:
                raise SystemExit(1)
            delay = 60
        if args.once:
            return
        time.sleep(delay)


if __name__ == '__main__':
    main()
