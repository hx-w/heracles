"""Versioned local training overlays. Garmin snapshots are never overwritten."""
import hashlib
import json
from datetime import date, timedelta
from uuid import uuid4

from heracles.domain.models import TrainingProposal
from heracles.storage import now, today


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def session_key(session):
    return session['date'] + ':' + (session.get('base_workout_id') or 'independent')


def baseline(plan, session):
    if session.get('base_workout_id'):
        workout = next((w for w in plan.get('workouts', []) if w['id'] == session['base_workout_id'] and w['date'] == session['date']), None)
        if not workout or workout.get('status') in {'completed', 'skipped'}:
            raise ValueError('原课程已变更或结束，请重新让教练评估')
        return {k: v for k, v in workout.items() if k not in {'detail_error'}}
    courses = [w for w in plan.get('workouts', []) if w['date'] == session['date']]
    if courses:
        raise ValueError('当天已有佳明课程，调整必须指定原课程，不能额外叠加')
    return None


class Planning:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')

    @staticmethod
    def read(db, key, default=None):
        row = db.execute('SELECT value FROM state WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @staticmethod
    def records(db):
        return [json.loads(row[0]) for row in db.execute('SELECT payload FROM proposals ORDER BY rowid DESC')]

    @staticmethod
    def write(db, record):
        db.execute('INSERT INTO proposals VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (record['id'], json.dumps(record, ensure_ascii=False)))

    def session_invalid_reason(self, record, session, plan, checkin):
        if plan.get('status') == 'error':
            return '佳明同步失败，请同步成功后重新评估'
        if date.fromisoformat(session['date']) < today():
            return '课程日期已过'
        try:
            if digest(baseline(plan, session)) != session['baseline_hash']:
                return '佳明原课程已变化，请重新评估'
        except ValueError as exc:
            return str(exc)
        if session['date'] == today().isoformat() and digest(checkin) != record['checkin_hash']:
            return '今天的状态已更新，请重新评估'
        return None

    def invalid_reason(self, record, plan, checkin):
        return next((reason for session in record['sessions']
                     if session.get('state') != 'superseded'
                     and (reason := self.session_invalid_reason(record, session, plan, checkin))), None)

    def state(self, plan=None):
        plan = plan if plan is not None else self.store.get('plan', {})
        checkin = self.store.get('checkin:' + today().isoformat())
        with self.store.connect() as db:
            records = self.records(db)
        for record in records:
            record['invalid_reason'] = self.invalid_reason(record, plan, checkin) if record['status'] == 'pending' else None
            for session in record['sessions']:
                session['invalid_reason'] = self.session_invalid_reason(record, session, plan, checkin) if record['status'] == 'active' else None
            if record['status'] == 'pending' and any(date.fromisoformat(s['date']) < today() for s in record['sessions']):
                record['invalid_reason'] = '方案日期已过，请重新评估'
        return records

    def draft(self, proposal: TrainingProposal, context):
        plan = context['plan']
        if plan.get('status') == 'error':
            raise ValueError('佳明同步失败，暂不生成可采用的训练方案')
        sessions, keys = [], set()
        checkin = context.get('checkin')
        for item in proposal.sessions:
            session = item.model_dump()
            day = date.fromisoformat(session['date'])
            if not today() <= day <= today() + timedelta(days=13):
                raise ValueError('训练方案仅支持今天起14天内的安排')
            key = session_key(session)
            if key in keys:
                raise ValueError('同一课程不能在方案中重复调整')
            keys.add(key)
            original = baseline(plan, session)
            if day == today() and checkin:
                if checkin['soreness'] == 'pain' and session['kind'] != 'rest':
                    raise ValueError('反馈疼痛时只能生成暂停训练方案，请先评估疼痛')
                seconds = sum((step.duration_seconds or 0) * step.repeat for step in item.steps)
                if seconds > checkin['available_minutes'] * 60:
                    raise ValueError('训练步骤总时长超过今天的可用时间')
            session.update(baseline=original, baseline_hash=digest(original), state='active')
            sessions.append(session)
        record = {'id': uuid4().hex, 'title': proposal.title, 'rationale': proposal.rationale,
                  'sessions': sessions, 'status': 'pending', 'created_at': now(), 'updated_at': now(),
                  'checkin_hash': digest(checkin), 'revision_hash': digest(context.get('active_sessions', []))}
        # Validate against the latest snapshot; inference can take minutes.
        current_plan = self.store.get('plan', {})
        reason = self.invalid_reason(record, current_plan, self.store.get('checkin:' + today().isoformat()))
        if reason:
            record.update(status='stale', invalid_reason=reason)
        with self.store.connect() as db:
            self.write(db, record)
        return record

    def decide(self, identifier, action):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            records = self.records(db)
            record = next((r for r in records if r['id'] == identifier), None)
            if not record:
                raise LookupError('训练方案不存在')
            desired = {'accept': 'active', 'dismiss': 'dismissed', 'revert': 'reverted'}[action]
            if record['status'] == desired:
                return record
            allowed = 'active' if action == 'revert' else 'pending'
            if record['status'] != allowed:
                raise ValueError('方案状态已改变，请刷新后重试')
            if action == 'accept':
                plan = self.read(db, 'plan', {})
                reason = self.invalid_reason(record, plan, self.read(db, 'checkin:' + today().isoformat()))
                if reason:
                    raise ValueError(reason)
                if any(date.fromisoformat(s['date']) < today() for s in record['sessions']):
                    raise ValueError('方案日期已过，请重新评估')
                active = self.effective(records, plan, self.read(db, 'checkin:' + today().isoformat()))
                if digest(active) != record['revision_hash']:
                    raise ValueError('已采用的方案发生变化，请重新让教练评估')
                keys = {session_key(s) for s in record['sessions']}
                for previous in records:
                    if previous['status'] != 'active':
                        continue
                    for session in previous['sessions']:
                        if session_key(session) in keys:
                            session['state'] = 'superseded'
                    if all(s.get('state') == 'superseded' for s in previous['sessions']):
                        previous['status'] = 'superseded'
                    self.write(db, previous)
            record.update(status=desired, updated_at=now())
            self.write(db, record)
            return record

    def effective(self, records, plan, checkin):
        return [{**session, 'proposal_id': record['id']} for record in records
                if record['status'] == 'active'
                for session in record['sessions'] if session.get('state') == 'active'
                and not self.session_invalid_reason(record, session, plan, checkin)]

    def active(self, plan=None):
        plan = plan if plan is not None else self.store.get('plan', {})
        with self.store.connect() as db:
            return self.effective(self.records(db), plan, self.store.get('checkin:' + today().isoformat()))
