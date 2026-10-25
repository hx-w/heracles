"""Private coaching and versioned training overlays with DeepSeek Harness."""
import asyncio
from datetime import datetime

from harness.client import generate, status
from heracles.domain.metrics import fresh_metrics
from heracles.domain.planning import Planning
from heracles.domain.visuals import resolve_visuals, visualization_catalog
from heracles.integrations.garmin import GarminData, empty_health, empty_plan, safe_error
from heracles.integrations.garmin_structured import compact, private_summary
from heracles.integrations.images import IMAGE_ERROR, explicitly_requests_image, generate_image
from heracles.storage import DEFAULT_PROFILE, Store, today


def activity_for_coach(payload, request):
    """Keep lossless SDK data local; return summaries or an explicitly bounded native window."""
    projection = {key: value for key, value in payload.items() if key not in ('native', 'sources')}
    native = payload.get('native') or {}
    projection['native'] = {key: value for key, value in native.items() if key != 'data'}
    projection['native']['data'] = {key: value for key, value in (native.get('data') or {}).items() if key != 'messages'}
    projection['sources'] = {key: record if key != 'chart' else {**record, 'data': payload.get('streams', {}).get('chart')} for key, record in payload.get('sources', {}).items()}
    result = compact(projection)
    result['raw_data_retained_locally'] = bool(payload.get('sources') or native.get('data'))
    if not request.metrics:
        result['native_query'] = '用 metrics 指定原始 FIT 字段，可用 start_at/end_at 限定带时区的时间窗口。默认只返回完整摘要、分段、区间和原始记录统计。'
        return result
    start = datetime.fromisoformat(request.start_at) if request.start_at else None
    end = datetime.fromisoformat(request.end_at) if request.end_at else None
    records = []
    for message in (payload.get('native', {}).get('data') or {}).get('messages', []):
        if message.get('type') != 'record':
            continue
        fields = message.get('fields') or []
        stamp = next((field.get('value') for field in fields if field.get('name') == 'timestamp'), None)
        if (start or end) and not stamp:
            continue
        measured = datetime.fromisoformat(stamp) if stamp else None
        if measured and ((start and measured < start) or (end and measured > end)):
            continue
        records.append({'timestamp': stamp, 'fields': [{key: field.get(key) for key in ('name', 'value', 'units')} for field in fields if field.get('name') in request.metrics]})
    result['native_records'] = records[:256]
    result['native_window'] = {'metrics': request.metrics, 'start_at': request.start_at, 'end_at': request.end_at, 'total_records': len(records), 'returned_records': min(256, len(records)), 'omitted_records': max(0, len(records) - 256), 'next_record_at': records[256]['timestamp'] if len(records) > 256 else None, 'sampling': '原生 FIT 记录，非降采样；这里只返回时间窗口的前256条，其余仍保留在本地。'}
    return result


class CoachService:
    def __init__(self):
        self.store = Store()
        self.garmin = GarminData(self.store)
        self.coach_status = {'available': False, 'busy': False, 'error': None, 'phase': None, 'model': None, 'provider': None, 'session_id': None}
        self.harness_busy = False
        self.sync_running = False
        self.jobs = set()

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.jobs.add(task)
        task.add_done_callback(self.jobs.discard)
        return task

    async def refresh_status(self):
        health = await status()
        self.harness_busy = health.get('busy', False)
        self.coach_status.update({key: health.get(key) for key in ('available', 'model', 'provider', 'session_id')})

    async def start(self):
        self.ensure_plan()
        await self.refresh_status()
        self.spawn(self.poll_garmin())

    async def stop(self):
        pending = list(self.jobs)
        for job in pending:
            job.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    def state(self):
        plan = self.ensure_plan()
        health = self.store.get('health', empty_health())
        planning = Planning(self.store)
        return {'today': today().isoformat(), 'timezone': 'Asia/Shanghai', 'profile': self.store.get('profile', DEFAULT_PROFILE), 'plan': plan, 'messages': self.store.get('messages', []), 'coach': dict(self.coach_status), 'syncing': self.sync_running,
                'checkin': self.store.get('checkin:' + today().isoformat()), 'proposals': planning.state(plan),
                'active_sessions': planning.active(plan),
                'connection': {'garmin': bool(health.get('account', {}).get('connected')), 'synced_at': health.get('synced_at'), 'sync_error': health.get('sync_error')},
                'metrics': [{**m, 'fresh': m['key'] in fresh_metrics(health)} for m in health.get('metrics', []) if m['key'] in {'sleep_hours', 'hrv', 'readiness', 'recovery_hours'}]}

    def ensure_plan(self):
        plan = self.store.get('plan')
        if plan and plan.get('source') == 'garmin':
            return plan
        # A generated legacy plan cannot become a Garmin snapshot by relabeling it.
        plan = empty_plan()
        self.store.put('plan', plan)
        return plan

    async def sync_data(self):
        if self.sync_running:
            while self.sync_running:
                await asyncio.sleep(0.2)
            return self.store.get('health', empty_health())
        self.sync_running = True
        try:
            return await asyncio.to_thread(self.garmin.sync)
        except Exception as exc:
            # A failed sync is a stale snapshot, not an empty plan or a new prescription.
            error = safe_error(exc)
            health = self.store.get('health', empty_health())
            health['sync_error'] = error
            for metric in health.get('metrics', []):
                metric['status'] = 'error'
            plan = self.ensure_plan()
            plan.update(status='error', sync_error=error)
            self.store.put_many({'health': health, 'plan': plan})
            return health
        finally:
            self.sync_running = False

    async def poll_garmin(self):
        while True:
            await self.sync_data()
            await asyncio.sleep(900)

    def coaching_context(self):
        health = self.store.get('health', empty_health())
        health = private_summary({**health, 'account': {key: health.get('account', {}).get(key) for key in ('region', 'connected')}})
        details = self.garmin.coach_context()
        details = {key: value for key, value in details.items() if key not in ('metrics', 'sources', 'plan')}
        return {'today': today().isoformat(), 'timezone': 'Asia/Shanghai', 'profile': self.store.get('profile', DEFAULT_PROFILE), 'health': health, 'plan': self.ensure_plan(), 'history': self.store.get('messages', [])[-30:], 'fresh_metrics': fresh_metrics(health), 'garmin_context': details, 'visualization_catalog': visualization_catalog(self.store.get('garmin_health_raw', {}), today()),
                'checkin': self.store.get('checkin:' + today().isoformat()), 'active_sessions': Planning(self.store).active()}

    def data_tool(self, request):
        if request.action == 'refresh_data':
            self.garmin.sync()
            context = self.coaching_context()
            return {key: context[key] for key in ('health', 'plan', 'fresh_metrics', 'garmin_context', 'visualization_catalog', 'checkin', 'active_sessions')}
        if request.action == 'friends_feed':
            return self.garmin.friends()
        if request.action == 'activity_details':
            return activity_for_coach(self.garmin.activity_details(request.activity_id), request)
        if request.action == 'health_details':
            return self.garmin.health_details(request.date, request.source)
        if request.action == 'workout_details':
            return self.garmin.workout_details(request.workout_id)
        raise ValueError('不支持的数据工具请求')

    async def coach_turn(self):
        try:
            self.coach_status['phase'] = '同步身体指标与佳明计划'
            await self.sync_data()
            context = await asyncio.to_thread(self.coaching_context)
            self.coach_status['phase'] = '教练正在解读指标与计划'
            phases = {'refresh_data': '重新同步佳明', 'friends_feed': '读取好友动态', 'activity_details': '读取运动详细数据', 'health_details': '读取身体指标明细', 'workout_details': '读取佳明课程步骤'}
            reply = await generate(context, self.data_tool, lambda action: self.coach_status.update(phase=phases[action]))
            if reply.profile_update:
                self.store.put('profile', reply.profile_update.model_dump())
            visuals = resolve_visuals(reply.visuals, context.get('visualization_catalog', {}), datetime.fromisoformat(context['today']).date() if context.get('today') else today())
            images, image_error = None, None
            if reply.illustration:
                latest = next((message['content'] for message in reversed(context.get('history', [])) if message.get('role') == 'user'), '')
                if not explicitly_requests_image(latest):
                    image_error = '本轮未明确请求示意图，因此未发送图像生成请求。'
                else:
                    self.coach_status['phase'] = '生成示意图'
                    try:
                        data, metadata = await asyncio.to_thread(generate_image, reply.illustration.subject)
                        images = [await asyncio.to_thread(self.store.save_image, data, metadata, reply.illustration)]
                    except Exception:
                        image_error = IMAGE_ERROR
            proposal_id, proposal_error = None, None
            if reply.proposal:
                try:
                    proposal_id = Planning(self.store).draft(reply.proposal, context)['id']
                except ValueError as exc:
                    proposal_error = '训练方案未保存：' + str(exc)
            self.store.message('assistant', reply.summary, sections=[section.model_dump() for section in reply.sections], visuals=visuals, images=images, image_error=image_error, proposal_id=proposal_id, proposal_error=proposal_error)
            self.coach_status['error'] = None
        except Exception as exc:
            error = str(exc) if isinstance(exc, (ValueError, RuntimeError, asyncio.TimeoutError)) else '教练未能完成本轮分析，请稍后重试'
            if isinstance(exc, asyncio.TimeoutError):
                error = 'DeepSeek 分析超过等待时间，请稍后重试'
            self.coach_status['error'] = error
            self.store.message('assistant', '本轮分析未完成：' + error)
        finally:
            await self.refresh_status()
            self.coach_status['busy'] = False
            self.coach_status['phase'] = None
