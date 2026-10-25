"""Official DeepSeek Harness SDK, isolated tool-free coaching sessions."""
import asyncio
import importlib.util
import json
import os
import threading
from uuid import uuid4

from heracles.domain.models import CoachReply
from heracles.storage import DATA, ROOT

MODEL = 'deepseek-flash'
LOCK = threading.Lock()


def request(path, payload=None):
    if path != '/turn' or not payload:
        raise RuntimeError('不支持的 DeepSeek Harness 请求')
    if not os.environ.get('DEEPSEEK_API_KEY'):
        raise RuntimeError('服务器尚未配置 DEEPSEEK_API_KEY')
    from deepseek_harness import DeepSeekHarness
    workspace = DATA / 'deepseek' / 'workspace'
    workspace.mkdir(parents=True, mode=0o700, exist_ok=True)
    home = DATA / 'deepseek' / 'home'
    home.mkdir(parents=True, mode=0o700, exist_ok=True)
    # One fresh session per inference. No global profile, shell or user-home discovery.
    runtime = DeepSeekHarness(
        dsh_home=str(home), cwd=str(workspace), profile='sdk-minimal',
        patches=(str(ROOT / 'harness/coach.patch.yml'),),
        provider='deepseek-official', model=MODEL, reasoning_effort='low',
        max_tokens=8192, request_timeout_seconds=240,
        env={'DSH_SYSTEM_PROMPT': (ROOT / 'harness/prompt.txt').read_text(),
             'DSH_PRIMARY_RUNTIME': '', 'DSH_TELEMETRY': 'false'},
    )
    with LOCK:
        try:
            runtime.start()
            result = runtime.run('context=' + json.dumps(payload['context'], ensure_ascii=False), session_id='heracles-' + uuid4().hex)
            if result.finish_reason != 'completed':
                raise RuntimeError('DeepSeek 本轮推理未完成')
            text = result.final_response
            json.loads(text)
            return {'text': text, 'model': MODEL, 'provider': 'deepseek-official'}
        except TimeoutError:
            raise RuntimeError('DeepSeek 分析超时，请稍后重试') from None
        except Exception:
            # Provider diagnostics can contain request content; never expose them in chat.
            raise RuntimeError('DeepSeek 未能返回完整的结构化回复，请检查模型服务后重试') from None
        finally:
            runtime.close()


async def status():
    configured = bool(os.environ.get('DEEPSEEK_API_KEY')) and importlib.util.find_spec('deepseek_harness') is not None
    return {'available': configured, 'model': MODEL, 'provider': 'deepseek-official',
            'busy': LOCK.locked(), 'session_id': None}


async def generate(context, tools, progress=None):
    payload = dict(context)
    payload['response_schema'] = CoachReply.model_json_schema()
    first = await asyncio.to_thread(request, '/turn', {'context': payload})
    reply = CoachReply.model_validate_json(first['text'])
    if reply.tool_requests:
        results = []
        for tool in reply.tool_requests:
            if progress:
                progress(tool.action)
            try:
                data = await asyncio.to_thread(tools, tool)
                results.append({'action': tool.action, 'parameters': tool.model_dump(exclude_none=True), 'data': data})
            except Exception as exc:
                from heracles.integrations.garmin import safe_error
                results.append({'action': tool.action, 'error': safe_error(exc)})
        payload['tool_results'] = results
        payload['tool_round_finished'] = True
        # A refreshed snapshot replaces the context, never a model-authored plan.
        for result in results:
            if result['action'] == 'refresh_data' and 'data' in result:
                snapshot = result['data']
                for key in ('health', 'plan', 'fresh_metrics', 'garmin_context', 'visualization_catalog', 'checkin', 'active_sessions'):
                    if key in snapshot:
                        payload[key] = snapshot[key]
                        context[key] = snapshot[key]
                # Save charts from the exact catalog shown to the final inference turn.
                context['visualization_catalog'] = snapshot['visualization_catalog']
                result['data'] = {'synced_at': snapshot['health'].get('synced_at'), 'plan_status': snapshot['plan']['status']}
        second = await asyncio.to_thread(request, '/turn', {'context': payload})
        reply = CoachReply.model_validate_json(second['text'])
        if reply.tool_requests:
            raise RuntimeError('教练本轮未完成数据查询，请稍后重试')
    return reply
