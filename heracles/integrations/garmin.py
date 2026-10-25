"""Read-only Garmin China integration. Device timestamps never become fetch timestamps."""
import base64
import hashlib
import json
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

from garminconnect import Garmin

from heracles.storage import DATA, TZ, now, today
from heracles.integrations.garmin_structured import (
    NativeDecodeError, chart_inventory, compact, decode_native, fetch_record, fetch_workout,
    native_inventory, private_summary, source_date, sport_kind, stream_inventory,
    sync_plan, workout_steps,
)

SOURCES = [('stats', '每日身体与活动统计'), ('heart', '心率'), ('battery', '身体电量'), ('battery_events', '身体电量影响因素'), ('sleep', '睡眠'), ('hrv', 'HRV'), ('readiness', '训练准备度 / 恢复'), ('stress', '压力'), ('training', '训练负荷'), ('respiration', '呼吸'), ('spo2', '血氧'), ('threshold', '乳酸阈值'), ('heart_rate_zones', '心率区间'), ('power_zones', '功率区间'), ('cycling_ftp', '骑行 FTP'), ('endurance', '耐力评分'), ('hill', '爬坡能力'), ('race_predictions', '比赛预测'), ('running_tolerance', '跑步承受能力'), ('activities', '运动记录')]
METRICS = [('heart_rate', '最近心率', 'bpm'), ('resting_hr', '静息心率', 'bpm'), ('body_battery', '身体电量', '/100'), ('sleep_hours', '睡眠时长', '小时'), ('sleep_score', '睡眠评分', '/100'), ('hrv', '夜间 HRV', 'ms'), ('readiness', '训练准备度', '/100'), ('recovery_hours', '恢复时间', '小时'), ('stress', '平均压力', '/100'), ('vo2max', '跑步 VO₂ max', 'ml/kg/min'), ('acute_load', '急性训练负荷', ''), ('lactate_hr', '乳酸阈值心率', 'bpm'), ('respiration', '平均清醒呼吸率', '次/分钟'), ('spo2', '平均血氧', '%'), ('steps', '每日步数', '步')]
DAILY_METHODS = {'stats': 'get_stats', 'heart': 'get_heart_rates', 'battery': 'get_body_battery', 'battery_events': 'get_body_battery_events', 'sleep': 'get_sleep_data', 'hrv': 'get_hrv_data', 'readiness': 'get_training_readiness', 'stress': 'get_stress_data', 'training': 'get_training_status', 'respiration': 'get_respiration_data', 'spo2': 'get_spo2_data'}
CAPABILITY_METHODS = {'threshold': 'get_lactate_threshold', 'heart_rate_zones': 'get_heart_rate_zones', 'power_zones': 'get_power_zones', 'cycling_ftp': 'get_cycling_ftp', 'endurance': 'get_endurance_score', 'hill': 'get_hill_score', 'race_predictions': 'get_race_predictions', 'running_tolerance': 'get_running_tolerance'}


def timestamp(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        if value <= 0:
            return None
        return datetime.fromtimestamp(value / 1000 if value > 10**11 else value, TZ).isoformat(timespec='seconds')
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return (dt.replace(tzinfo=TZ) if dt.tzinfo is None else dt.astimezone(TZ)).isoformat(timespec='seconds')
    except ValueError:
        return None


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


def pace(distance, seconds):
    if not distance or not seconds:
        return None
    total = round(seconds / (distance / 1000))
    return f'{total // 60}:{total % 60:02d} /km'


def activity(raw):
    distance = number(raw.get('distance'))
    duration = number(raw.get('duration'))
    return {'id': raw.get('activityId'), 'date': timestamp(raw.get('startTimeLocal')), 'name': raw.get('activityName', '运动'), 'sport': raw.get('activityType', {}).get('typeKey', 'unknown'), 'distance_km': round(distance / 1000, 2) if distance is not None else None, 'duration_minutes': round(duration / 60, 1) if duration is not None else None, 'average_hr': number(raw.get('averageHR')), 'max_hr': number(raw.get('maxHR')), 'pace': pace(distance, duration), 'cadence': number(raw.get('averageRunningCadenceInStepsPerMinute')), 'elevation_gain': number(raw.get('elevationGain')), 'aerobic_effect': number(raw.get('aerobicTrainingEffect')), 'anaerobic_effect': number(raw.get('anaerobicTrainingEffect')), 'calories': number(raw.get('calories'))}


def empty_plan(error=None):
    return {'source': 'garmin', 'status': 'error' if error else 'missing', 'sync_error': error, 'fetched_at': None, 'updated_at': None, 'name': None, 'plans': [], 'phases': [], 'workouts': []}


def empty_health(error=None):
    return {'metrics': [{'key': k, 'label': label, 'value': None, 'unit': unit, 'source_at': None, 'fetched_at': None, 'status': 'missing', 'detail': '尚无设备数据'} for k, label, unit in METRICS], 'daily': [], 'activities': [], 'sources': [], 'synced_at': None, 'sync_error': error, 'account': {'region': 'China', 'connected': False, 'identity_verified': False, 'label': '佳明中国，尚未连接'}, 'poll_seconds': 900}


class GarminData:
    def __init__(self, store):
        self.store = store
        self.client = None
        self.account_profile = None
        self.lock = threading.RLock()
        legacy_store = Path.home() / '.config/garmin-sign'
        default_store = legacy_store if (legacy_store / 'garmin_tokens.json').exists() else DATA / 'garmin'
        self.tokenstore = Path(os.environ.get('GARMIN_TOKENSTORE', str(default_store))).expanduser()

    def connect(self):
        if self.client:
            return self.client
        tokenfile = self.tokenstore / 'garmin_tokens.json'
        if tokenfile.exists():
            saved = json.loads(tokenfile.read_text())
            token = saved.get('di_token', '')
            if len(token.split('.')) == 3:
                claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '=='))
                if claims.get('iss', '').endswith('garmin.com'):
                    raise RuntimeError('现有令牌属于佳明国际区，不能用于佳明中国。需要中国区登录。')
        email, password = os.environ.get('GARMIN_EMAIL'), os.environ.get('GARMIN_PASSWORD')
        if not tokenfile.exists() and not (email and password):
            raise RuntimeError('未找到佳明中国认证；请在主机运行 python login.py，密码不会进入网页或对话。')
        client = Garmin(email=email, password=password, is_cn=True, retry_attempts=0)
        client.login(str(self.tokenstore))
        self.client = client
        return client

    def _health_record(self, client, key, day, previous=None):
        if key in DAILY_METHODS:
            method = DAILY_METHODS[key]
            call = lambda: getattr(client, method)(day)
        else:
            method = CAPABILITY_METHODS[key]
            if key in {'endurance', 'hill'}:
                call = lambda: getattr(client, method)(day)
            elif key == 'running_tolerance':
                call = lambda: client.get_running_tolerance((datetime.fromisoformat(day).date() - timedelta(days=28)).isoformat(), day)
            else:
                call = lambda: getattr(client, method)()
        return fetch_record(call, previous, 'garminconnect.' + method, now(), safe_error, lambda payload: source_time(key, payload), day)

    def sync(self):
        with self.lock:
            old = self.store.get('health', empty_health())
            old_plan = self.store.get('plan', empty_plan())
            old_plan = old_plan if isinstance(old_plan, dict) and old_plan.get('source') == 'garmin' else empty_plan()
            at, day = now(), today().isoformat()
            try:
                client = self.connect()
            except Exception as exc:
                error = safe_error(exc)
                old['sync_error'] = error
                old.setdefault('account', {})['connected'] = False
                old_plan.update(status='error', sync_error=error)
                self.store.put_many({'health': old, 'plan': old_plan})
                return old
            history = self.store.get('garmin_health_raw', {})
            if day not in history:
                legacy_raw = self.store.get('raw', {})
                for key, record in legacy_raw.items():
                    if key in dict(SOURCES) and record.get('date'):
                        date_key = record['date']
                        history.setdefault(date_key, {}).setdefault(key, {**record, 'status': record.get('status', 'available' if record.get('data') else 'missing'), 'error': record.get('error'), 'requested_date': date_key, 'data_date': date_key, 'source_at': source_time(key, record.get('data'))})
            current = history.setdefault(day, {})
            raw, sources = {}, []
            old_sources = {s['key']: s for s in old.get('sources', [])}
            for key, label in SOURCES:
                previous = current.get(key)
                if previous is None:
                    previous = next((history[d][key] for d in sorted(history, reverse=True) if d < day and key in history[d]), None)
                if key == 'activities':
                    record = fetch_record(lambda: client.get_activities(0, 100), previous, 'garminconnect.get_activities', at, safe_error, lambda p: source_time(key, p), day)
                elif key in CAPABILITY_METHODS and previous and previous.get('status') != 'error' and previous.get('data_date') == day:
                    record = previous
                else:
                    record = self._health_record(client, key, day, previous)
                current[key] = record
                raw[key] = {'data': record.get('data'), 'fetched_at': record.get('fetched_at'), 'date': record.get('data_date') or record.get('date') or day, 'status': record['status'], 'error': record['error'], 'error_at': record.get('error_at'), 'attempted_at': record.get('attempted_at')}
                previous_source = old_sources.get(key, {})
                observation = {k: previous_source.get(k) for k in ('last_changed_at', 'observations', 'changes', 'sample_interval_seconds')}
                if record['status'] != 'error':
                    digest = hashlib.sha256(json.dumps(record.get('data'), sort_keys=True).encode()).hexdigest()
                    observation = self.store.observe(key, digest, record.get('source_at'))
                sources.append({'key': key, 'label': label, 'status': record['status'], 'fetched_at': record.get('fetched_at'), 'source_at': record.get('source_at'), 'data_date': record.get('data_date') or record.get('date'), 'requested_date': day, 'error': record['error'], 'error_at': record.get('error_at'), 'attempted_at': record.get('attempted_at'), **observation})
            raw['fitness'] = {'data': {'threshold': (raw['threshold'].get('data') or {}).get('speed_and_heart_rate') or {}, 'heart_rate_zones': raw['heart_rate_zones'].get('data')}, 'fetched_at': raw['threshold'].get('fetched_at'), 'date': day}
            # Cache actual recent per-day detail, refreshing yesterday for late device uploads.
            # Failures are per source, so missing HRV never hides a valid sleep or stats record.
            daily = []
            for offset in range(7, 0, -1):
                date_key = (today() - timedelta(days=offset)).isoformat()
                records = history.setdefault(date_key, {})
                for key in DAILY_METHODS:
                    if key == 'battery_events':
                        continue
                    prior = records.get(key)
                    if not prior or offset == 1 or prior.get('status') == 'error':
                        records[key] = self._health_record(client, key, date_key, prior)
                daily.append(self._daily_summary(date_key, records))
            plan_cache = self.store.get('garmin_plan_raw', {})
            plan = sync_plan(client, old_plan, plan_cache, at, safe_error, number, empty_plan)
            activities = [activity(a) for a in raw.get('activities', {}).get('data') or []]
            threshold = (raw['fitness']['data'].get('threshold') or {})
            calibration = {'lactate_threshold_hr': number(threshold.get('heartRate')), 'lactate_threshold_speed_raw': number(threshold.get('speed')), 'speed_unit': 'Garmin 原始阈值字段，未确认换算，不用于数字配速建议', 'threshold_recorded_date': source_date(threshold.get('calendarDate')), 'heart_rate_zones': raw['heart_rate_zones'].get('data'), 'power_zones': raw['power_zones'].get('data'), 'hrv_summary': (raw.get('hrv', {}).get('data') or {}).get('hrvSummary', {})}
            history_errors = any(r.get('status') == 'error' for row in history.values() for r in row.values())
            health = {'metrics': normalize(raw, sources), 'daily': daily, 'activities': activities, 'sources': sources, 'synced_at': at, 'sync_error': '部分接口暂不可用；见各数据来源' if any(s['status'] == 'error' for s in sources) or history_errors else None, 'account': {'region': 'China', 'connected': True, 'identity_verified': client.full_name == '贺翔', 'label': '佳明中国，' + (client.full_name or '已认证')}, 'poll_seconds': 900, 'fitness': calibration}
            # Consumers can never observe new health with an old plan or old underlying raw sources.
            self.store.put_many({'raw': raw, 'garmin_health_raw': history, 'garmin_plan_raw': plan_cache, 'health': health, 'plan': plan})
            # Latest four real running/cycling recordings provide immediate coach analysis.
            recent = [a for a in raw['activities'].get('data') or [] if sport_kind((a.get('activityType') or {}).get('typeKey')) in {'running', 'cycling'}][:4]
            for row in recent:
                self._activity_details(client, str(row['activityId']), row)
            return health

    def _daily_summary(self, day, records):
        stats = (records.get('stats') or {}).get('data') or {}
        sleep = ((records.get('sleep') or {}).get('data') or {}).get('dailySleepDTO') or {}
        seconds = number(sleep.get('sleepTimeSeconds'))
        trend_stats = {key: stats.get(key) for key in ('totalSteps', 'restingHeartRate', 'minHeartRate', 'maxHeartRate', 'averageStressLevel', 'bodyBatteryHighestValue', 'bodyBatteryLowestValue', 'bodyBatteryChargedValue', 'bodyBatteryDrainedValue', 'moderateIntensityMinutes', 'vigorousIntensityMinutes')}
        sleep_summary = {key: sleep.get(key) for key in ('calendarDate', 'sleepTimeSeconds', 'deepSleepSeconds', 'lightSleepSeconds', 'remSleepSeconds', 'awakeSleepSeconds', 'sleepScores')}
        summaries = {'stats': trend_stats, 'sleep': sleep_summary, 'hrv': ((records.get('hrv') or {}).get('data') or {}).get('hrvSummary'), 'readiness': compact((records.get('readiness') or {}).get('data'))}
        for key in ('stress', 'respiration', 'spo2'):
            payload = (records.get(key) or {}).get('data') or {}
            summaries[key] = {name: value for name, value in payload.items() if not isinstance(value, (list, dict))}
        return {'date': day, 'resting_hr': number(stats.get('restingHeartRate')), 'sleep_hours': round(seconds / 3600, 2) if seconds is not None else None, 'sleep_score': number(((sleep.get('sleepScores') or {}).get('overall') or {}).get('value')), 'body_battery': number(stats.get('bodyBatteryHighestValue')), 'summaries': private_summary(summaries), 'availability': {key: {k: record.get(k) for k in ('status', 'source_at', 'fetched_at', 'error', 'error_at', 'data_date')} for key, record in records.items() if key in DAILY_METHODS}}

    def health_details(self, day=None, source=None):
        with self.lock:
            day = day or today().isoformat()
            if source_date(day) != day:
                raise ValueError('日期须为 YYYY-MM-DD')
            if source is not None and source not in DAILY_METHODS and source not in CAPABILITY_METHODS:
                raise ValueError('未知佳明健康数据来源')
            history = self.store.get('garmin_health_raw', {})
            records = history.setdefault(day, {})
            requested = [source] if source else list(DAILY_METHODS)
            try:
                client = self.connect()
            except Exception as exc:
                return {'source': 'garmin', 'date': day, 'sources': private_summary({key: records[key] for key in requested if key in records}), 'error': safe_error(exc), 'error_at': now()}
            for key in requested:
                # Global latest capability APIs must not be mislabeled as historical measurements.
                if key in CAPABILITY_METHODS and day != today().isoformat():
                    records.setdefault(key, {'data': None, 'status': 'missing', 'error': '此能力接口仅提供最近记录，不支持按历史日期查询', 'fetched_at': None, 'source_at': None, 'requested_date': day})
                elif key not in records or records[key].get('status') == 'error':
                    records[key] = self._health_record(client, key, day, records.get(key))
            self.store.put('garmin_health_raw', history)
            return {'source': 'garmin', 'date': day, 'sources': private_summary({key: records[key] for key in requested}), 'error': None}

    def workout_details(self, workout_id):
        with self.lock:
            plan = self.store.get('plan', empty_plan())
            known = next((w for w in plan.get('workouts', []) if w['id'] == str(workout_id)), None) if plan.get('source') == 'garmin' else None
            cache = self.store.get('garmin_plan_raw', {})
            record = cache.get('workouts', {}).get(str(workout_id))
            if not known and not record:
                raise ValueError('只能读取当前账号佳明计划中已获取的课程')
            if known and known['rest_day']:
                return {'source': 'garmin', 'workout': known, 'details': None, 'detail_status': 'not_applicable', 'error': None}
            if known and str(workout_id).startswith('garmin:') and not record:
                return {'source': 'garmin', 'workout': known, 'details': None, 'steps': known.get('steps', []), 'detail_status': 'summary', 'error': '佳明未提供可查询的课程编号或 UUID；仅有原始计划处方摘要'}
            if not record or record.get('status') == 'error':
                at = now()
                endpoint = ('/workout-service/workout/' if str(workout_id).isdigit() else '/workout-service/fbt-adaptive/') + str(workout_id)
                record = fetch_record(lambda: fetch_workout(self.connect(), workout_id)[0], record, endpoint, at, safe_error)
                cache.setdefault('workouts', {})[str(workout_id)] = record
                self.store.put('garmin_plan_raw', cache)
            return {'source': 'garmin', 'workout': known, 'details': private_summary(record.get('data')), 'provenance': {k: v for k, v in record.items() if k != 'data'}, 'steps': workout_steps(record.get('data') or {}), 'detail_status': record['status'], 'error': record.get('error')}

    def activity_details(self, activity_id):
        if not str(activity_id).isdigit() or int(activity_id) <= 0:
            raise ValueError('活动编号须为正整数')
        with self.lock:
            identifier = str(int(activity_id))
            try:
                client = self.connect()
            except Exception as exc:
                cached = self.store.get('garmin_activity:' + identifier, {})
                return {**private_summary(cached, keep_locations=True), 'source': 'garmin', 'activity_id': identifier, 'error': safe_error(exc), 'error_at': now()}
            return private_summary(self._activity_details(client, identifier), keep_locations=True)

    def _download_native(self, client, identifier):
        blob = client.download_activity(identifier, Garmin.ActivityDownloadFormat.ORIGINAL)
        digest = hashlib.sha256(blob).hexdigest()
        self.store.put('garmin_activity_export:' + identifier, {'source': 'garmin', 'activity_id': identifier, 'fetched_at': now(), 'encoding': 'base64', 'sha256': digest, 'data': base64.b64encode(blob).decode()})
        try:
            return decode_native(blob)
        except Exception as exc:
            raise NativeDecodeError() from exc

    def _account_profile_id(self, client, list_summary=None):
        if self.account_profile and self.account_profile[0] == client.display_name:
            return self.account_profile[1]
        if list_summary and list_summary.get('ownerDisplayName') == client.display_name and list_summary.get('ownerId') is not None:
            identifier = list_summary['ownerId']
        else:
            identifier = (client.connectapi('/userprofile-service/socialProfile') or {}).get('profileId')
        if identifier is None:
            raise ValueError('当前账号未提供可确认活动归属的标识')
        self.account_profile = (client.display_name, identifier)
        return identifier

    def _activity_details(self, client, identifier, list_summary=None):
        cache_key = 'garmin_activity:' + identifier
        cached = self.store.get(cache_key, {})
        records = cached.get('sources', {})
        calls = {'splits': lambda: client.get_activity_splits(identifier), 'typed_splits': lambda: client.get_activity_typed_splits(identifier), 'split_summaries': lambda: client.get_activity_split_summaries(identifier), 'heart_rate_zones': lambda: client.get_activity_hr_in_timezones(identifier), 'power_zones': lambda: client.get_activity_power_in_timezones(identifier), 'exercise_sets': lambda: client.get_activity_exercise_sets(identifier), 'weather': lambda: client.get_activity_weather(identifier), 'chart': lambda: client.get_activity_details(identifier)}
        at = now()
        previous_summary = records.get('summary')
        if not previous_summary or previous_summary.get('status') in {'error', 'missing'} or (list_summary is not None and cached.get('list_summary') != list_summary):
            records['summary'] = fetch_record(lambda: client.get_activity(identifier), previous_summary, '/activity-service/activity/' + identifier, at, safe_error)
        summary_payload = records['summary'].get('data') or {}
        try:
            account_id = self._account_profile_id(client, list_summary)
            owned = str(summary_payload.get('userProfileId')) == str(account_id)
        except Exception as exc:
            return {'source': 'garmin', 'activity_id': identifier, 'sources': {}, 'error': safe_error(exc), 'error_at': at, 'details_available': False}
        if not owned:
            return {'source': 'garmin', 'activity_id': identifier, 'sources': {}, 'error': records['summary'].get('error') or '无法确认该活动属于当前授权账号', 'error_at': at, 'details_available': False}
        for key, call in calls.items():
            previous = records.get(key)
            pending_chart = key == 'chart' and previous and (previous.get('status') == 'missing' or (previous.get('data') or {}).get('pendingData') or (previous.get('data') or {}).get('detailsAvailable') is False)
            if not previous or previous.get('status') == 'error' or pending_chart:
                suffix = {'typed_splits': 'typedsplits', 'split_summaries': 'split_summaries', 'heart_rate_zones': 'hrTimeInZones', 'power_zones': 'powerTimeInZones', 'exercise_sets': 'exerciseSets', 'chart': 'details'}.get(key, key)
                records[key] = fetch_record(call, previous, '/activity-service/activity/' + identifier + '/' + suffix, at, safe_error)
        native = cached.get('native', {})
        if not native or native.get('status') == 'error':
            native = fetch_record(lambda: self._download_native(client, identifier), native, '/download-service/files/activity/' + identifier, at, safe_error)
            # Original binary is independently retained even when FIT decoding fails.
            native['export_cache_key'] = 'garmin_activity_export:' + identifier
            if native['status'] != 'error':
                native['sampling'] = 'native FIT; device recording intervals, not necessarily per-second'
        chart = (records.get('chart') or {}).get('data') or {}
        summary = (records.get('summary') or {}).get('data') or {}
        result = {'source': 'garmin', 'activity_id': identifier, 'list_summary': list_summary or cached.get('list_summary'), 'summary': summary, 'sources': records, 'native': native, 'streams': {'chart': chart_inventory(chart, timestamp), 'native': native_inventory(native.get('data') or {})}, 'error': '部分活动明细暂不可用；见各来源' if any(r['status'] == 'error' for r in records.values()) or native.get('status') == 'error' else None}
        laps = ((records.get('splits') or {}).get('data') or {}).get('lapDTOs') or []
        result['laps'] = [{'index': index, 'distance_km': round(distance / 1000, 2) if (distance := number(lap.get('distance'))) is not None else None, 'duration_minutes': round(seconds / 60, 2) if (seconds := number(lap.get('duration'))) is not None else None, 'average_hr': number(lap.get('averageHR')), 'pace': pace(distance, seconds), 'raw': lap} for index, lap in enumerate(laps, 1)]
        result['details_available'] = bool(records.get('summary', {}).get('data'))
        self.store.put(cache_key, result)
        return result

    def coach_context(self):
        with self.lock:
            health = self.store.get('health', empty_health())
            history = self.store.get('garmin_health_raw', {})
            day = today().isoformat()
            records = history.get(day, {})
            recent_days = sorted(d for d in history if d <= day)[-8:]
            sleep_candidates = []
            for date_key in recent_days:
                record = history[date_key].get('sleep') or {}
                sleep = (record.get('data') or {}).get('dailySleepDTO') or {}
                if number(sleep.get('sleepTimeSeconds')) not in (None, 0):
                    measured_date = source_date(sleep.get('calendarDate')) or record.get('data_date') or date_key
                    sleep_candidates.append((measured_date, record))
            nearest_sleep = max(sleep_candidates, default=None, key=lambda entry: entry[0])
            activity_context = []
            raw_activities = self.store.get('raw', {}).get('activities', {}).get('data') or []
            list_summaries = {str(row.get('activityId')): row for row in raw_activities}
            for row in health.get('activities', [])[:20]:
                cached = self.store.get('garmin_activity:' + str(row['id']), {})
                activity_context.append({'activity': row, 'full_summary': compact((cached.get('sources', {}).get('summary') or {}).get('data') or list_summaries.get(str(row['id']))), 'analysis': {'laps': compact(cached.get('laps')), 'heart_rate_zones': compact((cached.get('sources', {}).get('heart_rate_zones') or {}).get('data')), 'power_zones': compact((cached.get('sources', {}).get('power_zones') or {}).get('data')), 'exercise_sets': compact((cached.get('sources', {}).get('exercise_sets') or {}).get('data'))}, 'streams': cached.get('streams'), 'error': cached.get('error')})
            plan = self.store.get('plan', empty_plan())
            plan = plan if isinstance(plan, dict) and plan.get('source') == 'garmin' else empty_plan()
            return private_summary({'source': 'garmin', 'metrics': health.get('metrics', []), 'sources': health.get('sources', []), 'synced_at': health.get('synced_at'), 'sync_error': health.get('sync_error'), 'current_body': {key: {'summary': compact(record.get('data')), 'provenance': {k: v for k, v in record.items() if k != 'data'}, 'streams': stream_inventory(record.get('data'), timestamp)} for key, record in records.items() if key != 'activities'}, 'nearest_available_sleep': {'date': nearest_sleep[0], 'summary': compact(nearest_sleep[1].get('data')), 'provenance': {k: v for k, v in nearest_sleep[1].items() if k != 'data'}} if nearest_sleep else None, 'recent_daily': [self._daily_summary(d, history[d]) for d in recent_days], 'activities': activity_context, 'plan': plan, 'prescription_semantics': 'workoutDescription is Garmin display summary, not a cap. Use actual step targetValueOne/Two and targetType. heart.rate.zone range uses bpm, pace.zone uses m/s (One faster than Two); preserve nulls, nested repeat groups and strength exercise names. Missing dates are not rest days. Chart samples may be decimated; native FIT retains original recording intervals.'})

    def friends(self):
        with self.lock:
            client = self.connect()
            payload = client.connectapi(
                '/userprofile-service/socialProfile/connections/pagination/' + quote(client.display_name, safe=''),
                params={'start': 0, 'limit': 20},
            )
            connections, activities = [], []
            for friend in payload.get('userConnections', [])[:20]:
                name = friend.get('fullName') or friend.get('displayName') or '佳明好友'
                display_name = friend.get('displayName')
                connection = {'name': name, 'visibility': 'unavailable', 'status': 'error', 'error': None}
                try:
                    if not display_name:
                        raise ValueError('好友未提供可读取的公开标识')
                    history = client.connectapi(
                        '/activitylist-service/activities/' + quote(display_name, safe=''),
                        params={'start': 0, 'limit': 5},
                    )
                    for raw in history.get('activityList', [])[:5]:
                        normalized = activity(raw)
                        activities.append({key: normalized[key] for key in ('name', 'date', 'sport', 'distance_km', 'duration_minutes', 'pace')} | {'owner': name})
                    connection.update(visibility='visible', status='available')
                except Exception as exc:
                    status_code = getattr(getattr(exc, 'response', None), 'status_code', None)
                    private = status_code == 403 or '403' in str(exc)
                    connection.update(visibility='private' if private else 'unavailable', error='好友隐私设置不允许当前账号读取活动' if private else safe_error(exc))
                connections.append(connection)
            activities.sort(key=lambda item: item.get('date') or '', reverse=True)
            return {'fetched_at': now(), 'scope': '仅好友允许当前账号查看的活动；不读取好友私人心率或健康数据', 'connections': connections, 'activities': activities}


def safe_error(exc):
    # Third-party exceptions may include request bodies, credentials or account identifiers.
    name = type(exc).__name__
    if isinstance(exc, RuntimeError) and str(exc) in {'现有令牌属于佳明国际区，不能用于佳明中国。需要中国区登录。', '未找到佳明中国认证；请在主机运行 python login.py，密码不会进入网页或对话。'}:
        return str(exc)
    if 'Authentication' in name:
        return '佳明认证失效或区域不匹配，请在主机重新登录中国区账号'
    if 'TooManyRequests' in name:
        return '佳明限制了请求频率，等待下一次同步'
    if name == 'NativeDecodeError':
        return '原始活动文件已下载并保留，但 FIT 解码失败；图表数据不是原始记录替代品'
    if 'Connection' in name or 'SSL' in name or 'Timeout' in name:
        return '佳明网络或接口请求失败，保留上次记录并标注时间'
    return f'佳明接口未能返回数据（{name}）'


def source_time(key, data):
    if key == 'heart' and isinstance(data, dict):
        values = data.get('heartRateValues') or []
        valid = [v for v in values if len(v) > 1 and number(v[1]) is not None and v[1] > 0]
        return timestamp(valid[-1][0]) if valid else None
    if key == 'battery' and isinstance(data, list):
        values = (data[-1].get('bodyBatteryValuesArray') or []) if data else []
        return timestamp(values[-1][0]) if values else None
    if key == 'activities' and isinstance(data, list):
        return timestamp(data[0].get('startTimeLocal')) if data else None
    if key == 'sleep' and isinstance(data, dict):
        return timestamp((data.get('dailySleepDTO') or {}).get('sleepEndTimestampGMT'))
    if key == 'readiness':
        rows = data if isinstance(data, list) else [data] if isinstance(data, dict) else []
        times = [timestamp(r.get('timestampLocal')) or timestamp(str(r['timestamp']).removesuffix('Z') + '+00:00') if r.get('timestamp') else timestamp(r.get('timestampLocal')) for r in rows]
        return max((t for t in times if t), default=None)
    if isinstance(data, dict):
        for field in ('latestSpO2TimestampGMT', 'measurementTimestampGMT', 'timestampGMT'):
            value = data.get(field)
            if value:
                return timestamp(value if isinstance(value, (int, float)) or str(value).endswith(('Z', '+00:00')) else str(value) + '+00:00')
        for field in ('respirationValuesArray', 'stressValuesArray'):
            values = data.get(field) or []
            if values:
                return timestamp(values[-1][0])
    # Some daily aggregates have no measurement timestamp. Do not invent midnight precision.
    return None


def normalize(raw, sources):
    metrics = {k: {'key': k, 'label': label, 'value': None, 'unit': unit, 'source_at': None, 'fetched_at': None, 'status': 'missing', 'detail': '佳明未提供该指标'} for k, label, unit in METRICS}
    source_map = {s['key']: s for s in sources}

    def set_metric(key, value, source, source_at=None, detail=''):
        record = raw.get(source, {})
        s = source_map.get(source, {})
        value = number(value)
        metrics[key].update(value=value, source_at=source_at or s.get('source_at'), fetched_at=record.get('fetched_at'), status='error' if s.get('status') == 'error' else 'available' if value is not None else 'missing', detail=detail or ('设备日期 ' + record.get('date', '未知') + '；无测量时间时不视为实时值'))

    heart = raw.get('heart', {}).get('data') or {}
    readings = [v for v in heart.get('heartRateValues', []) or [] if len(v) > 1 and number(v[1]) is not None and v[1] > 0]
    set_metric('heart_rate', readings[-1][1] if readings else None, 'heart', timestamp(readings[-1][0]) if readings else None)
    set_metric('resting_hr', heart.get('restingHeartRate'), 'heart', detail='佳明当日静息心率统计，设备日期 ' + raw.get('heart', {}).get('date', '未知') + '，不是即时心率')
    batteries = raw.get('battery', {}).get('data') or []
    bb = (batteries[-1].get('bodyBatteryValuesArray') or []) if batteries else []
    descriptors = (batteries[-1].get('bodyBatteryValueDescriptorDTOList') or []) if batteries else []
    index = next((d['bodyBatteryValueDescriptorIndex'] for d in descriptors if d.get('bodyBatteryValueDescriptorKey') == 'bodyBatteryLevel'), 1)
    valid_bb = [v for v in bb if len(v) > index and number(v[index]) is not None]
    set_metric('body_battery', valid_bb[-1][index] if valid_bb else None, 'battery', timestamp(valid_bb[-1][0]) if valid_bb else None)
    sleep = (raw.get('sleep', {}).get('data') or {}).get('dailySleepDTO') or {}
    seconds = number(sleep.get('sleepTimeSeconds'))
    set_metric('sleep_hours', round(seconds / 3600, 2) if seconds is not None else None, 'sleep')
    set_metric('sleep_score', ((sleep.get('sleepScores') or {}).get('overall') or {}).get('value'), 'sleep')
    hrv = (raw.get('hrv', {}).get('data') or {}).get('hrvSummary') or {}
    set_metric('hrv', hrv.get('lastNightAvg'), 'hrv', detail='上一晚 HRV，设备日期 ' + str(hrv.get('calendarDate', '未知')) + '，状态 ' + str(hrv.get('status', '未知')) + '；单次值不能诊断恢复状态')
    ready = raw.get('readiness', {}).get('data') or []
    rows = ready if isinstance(ready, list) else [ready]
    row = max(rows, key=lambda r: timestamp(r.get('timestampLocal')) or '') if rows else {}
    set_metric('readiness', row.get('score'), 'readiness')
    recovery = number(row.get('recoveryTime'))
    set_metric('recovery_hours', round(recovery / 60, 1) if recovery is not None else None, 'readiness', detail='设备日期 ' + str(row.get('calendarDate', '未知')) + '，佳明恢复时间按分钟换算小时；不是必须静止的时间')
    stress = raw.get('stress', {}).get('data') or {}
    set_metric('stress', stress.get('avgStressLevel'), 'stress')
    training = raw.get('training', {}).get('data') or {}
    generic = (training.get('mostRecentVO2Max') or {}).get('generic') or {}
    set_metric('vo2max', generic.get('vo2MaxPreciseValue'), 'training', detail='佳明估算值，记录日期 ' + str(generic.get('calendarDate', '未知')))
    set_metric('acute_load', row.get('acuteLoad'), 'readiness')
    fitness = raw.get('fitness', {}).get('data') or {}
    threshold = fitness.get('threshold') or (raw.get('threshold', {}).get('data') or {}).get('speed_and_heart_rate') or {}
    set_metric('lactate_hr', threshold.get('heartRate'), 'threshold' if 'threshold' in raw else 'fitness', detail='设备检测的个体阈值，不是最大心率；记录日期 ' + str(threshold.get('calendarDate', '未知'))[:10])
    set_metric('respiration', (raw.get('respiration', {}).get('data') or {}).get('avgWakingRespirationValue'), 'respiration')
    set_metric('spo2', (raw.get('spo2', {}).get('data') or {}).get('averageSpO2'), 'spo2')
    set_metric('steps', (raw.get('stats', {}).get('data') or {}).get('totalSteps'), 'stats')
    return list(metrics.values())
