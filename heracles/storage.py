"""Local private state and source observations. No credentials are stored here."""
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from uuid import uuid4
import re

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('HERACLES_DATA_DIR', str(ROOT / '.local'))).expanduser()
TZ = ZoneInfo('Asia/Shanghai')


def now():
    return datetime.now(TZ).isoformat(timespec='seconds')


def today():
    return datetime.now(TZ).date()


class Store:
    def __init__(self, path=None):
        DATA.mkdir(mode=0o700, exist_ok=True)
        self.path = Path(path) if path else DATA / 'paceme.sqlite'
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, source TEXT NOT NULL, observed_at TEXT NOT NULL, source_at TEXT, digest TEXT NOT NULL, changed INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)')
        os.chmod(self.path, 0o600)

    def connect(self):
        return sqlite3.connect(self.path, timeout=15)

    def get(self, key, default=None):
        with self.connect() as db:
            row = db.execute('SELECT value FROM state WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, key, value):
        with self.connect() as db:
            db.execute('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value, ensure_ascii=False)))

    def put_many(self, values):
        with self.connect() as db:
            db.executemany('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [(key, json.dumps(value, ensure_ascii=False)) for key, value in values.items()])

    def observe(self, source, digest, source_at):
        at = now()
        with self.connect() as db:
            previous = db.execute('SELECT digest FROM observations WHERE source=? ORDER BY id DESC LIMIT 1', (source,)).fetchone()
            changed = bool(previous and previous[0] != digest)
            db.execute('INSERT INTO observations (source,observed_at,source_at,digest,changed) VALUES (?,?,?,?,?)', (source, at, source_at, digest, int(changed)))
            count, changes = db.execute('SELECT COUNT(*),SUM(changed) FROM observations WHERE source=?', (source,)).fetchone()
            last = db.execute('SELECT observed_at FROM observations WHERE source=? AND changed=1 ORDER BY id DESC LIMIT 1', (source,)).fetchone()
            times = db.execute('SELECT observed_at FROM observations WHERE source=? ORDER BY id DESC LIMIT 2', (source,)).fetchall()
        interval = (datetime.fromisoformat(times[0][0]) - datetime.fromisoformat(times[1][0])).total_seconds() if len(times) == 2 else None
        return {'observations': count, 'changes': changes or 0, 'last_changed_at': last[0] if last else None, 'sample_interval_seconds': interval}

    def save_image(self, data, metadata, selection):
        directory = self.path.parent / 'images'
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)
        identifier = uuid4().hex
        path = directory / identifier
        with path.open('xb') as image:
            os.chmod(path, 0o600)
            image.write(data)
        snapshot = {**metadata, 'id': identifier, 'title': selection.title,
                    'caption': selection.caption, 'url': '/api/images/' + identifier, 'created_at': now()}
        try:
            with self.connect() as db:
                db.execute('INSERT INTO images VALUES (?,?)', (identifier, json.dumps(snapshot, ensure_ascii=False)))
        except Exception:
            path.unlink()
            raise
        return snapshot

    def image(self, identifier):
        if not re.fullmatch(r'[0-9a-f]{32}', identifier):
            return None
        with self.connect() as db:
            row = db.execute('SELECT metadata FROM images WHERE id=?', (identifier,)).fetchone()
        path = self.path.parent / 'images' / identifier
        if not row or path.is_symlink() or not path.is_file():
            return None
        return path, json.loads(row[0])

    def message(self, role, content, sections=None, visuals=None, images=None, image_error=None, proposal_id=None, proposal_error=None):
        messages = self.get('messages', [])
        message = {'role': role, 'content': content, 'created_at': now()}
        if sections is not None:
            message['sections'] = sections
        if visuals is not None:
            message['visuals'] = visuals
        if images is not None:
            message['images'] = images
        if image_error is not None:
            message['image_error'] = image_error
        if proposal_id:
            message['proposal_id'] = proposal_id
        if proposal_error:
            message['proposal_error'] = proposal_error
        messages.append(message)
        self.put('messages', messages)


DEFAULT_PROFILE = {'goal': '', 'target_date': None, 'weekly_days': 3, 'experience': '未填写', 'notes': ''}
