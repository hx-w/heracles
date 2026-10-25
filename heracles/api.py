"""Authenticated HTTP boundary; business state lives in CoachService."""
import hmac
import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from heracles.domain.models import CheckIn, Profile
from heracles.domain.planning import Planning
from heracles.storage import DATA, ROOT, now, today


class Chat(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


def install_routes(app, service):
    access_file = DATA / 'access-key'
    if not access_file.exists():
        access_file.write_text(secrets.token_urlsafe(32))
        access_file.chmod(0o600)
    access_key = access_file.read_text().strip()
    install_resources = {
        '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json'),
        '/sw.js': ('sw.js', 'application/javascript'),
        '/icons/icon-192.png': ('icons/icon-192.png', 'image/png'),
        '/icons/icon-512.png': ('icons/icon-512.png', 'image/png'),
        '/icons/maskable-192.png': ('icons/maskable-192.png', 'image/png'),
        '/icons/maskable-512.png': ('icons/maskable-512.png', 'image/png'),
        '/icons/apple-touch-icon.png': ('icons/apple-touch-icon.png', 'image/png'),
    }

    @app.middleware('http')
    async def private_access(request: Request, call_next):
        path = request.url.path
        public_install_resource = path in install_resources and request.method in {'GET', 'HEAD'}
        if path != '/healthz' and not public_install_resource:
            access = request.query_params.get('access', '')
            if path == '/' and access and hmac.compare_digest(access, access_key):
                response = RedirectResponse('/', status_code=303)
                response.set_cookie('heracles_session', access_key, httponly=True, secure=request.url.scheme == 'https', samesite='strict', max_age=365 * 24 * 3600)
                response.headers['Cache-Control'] = 'no-store'
                response.headers['Referrer-Policy'] = 'no-referrer'
                return response
            if not hmac.compare_digest(request.cookies.get('heracles_session', ''), access_key):
                return JSONResponse({'detail': '请使用服务器生成的私人访问链接打开 Heracles'}, status_code=401, headers={'Cache-Control': 'no-store'})
            origin = request.headers.get('origin')
            if request.method != 'GET' and origin:
                parsed = urlsplit(origin)
                if (parsed.scheme, parsed.netloc) != (request.url.scheme, request.url.netloc):
                    return JSONResponse({'detail': '拒绝跨站写入请求'}, status_code=403)
        response = await call_next(request)
        if not public_install_resource or request.query_params:
            response.headers['Cache-Control'] = 'no-store'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return response


    @app.get('/healthz')
    def healthz():
        return {'status': 'ok'}


    @app.api_route('/manifest.webmanifest', methods=['GET', 'HEAD'])
    @app.api_route('/sw.js', methods=['GET', 'HEAD'])
    @app.api_route('/icons/icon-192.png', methods=['GET', 'HEAD'])
    @app.api_route('/icons/icon-512.png', methods=['GET', 'HEAD'])
    @app.api_route('/icons/maskable-192.png', methods=['GET', 'HEAD'])
    @app.api_route('/icons/maskable-512.png', methods=['GET', 'HEAD'])
    @app.api_route('/icons/apple-touch-icon.png', methods=['GET', 'HEAD'])
    def install_resource(request: Request):
        filename, media_type = install_resources[request.url.path]
        headers = {'Cache-Control': 'public, max-age=86400'}
        if request.url.path == '/sw.js':
            headers = {'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/'}
        return FileResponse(ROOT / 'web/dist' / filename, media_type=media_type, headers=headers)


    @app.get('/')
    def index():
        return FileResponse(ROOT / 'web/dist/index.html')


    app.mount('/assets', StaticFiles(directory=ROOT / 'web/dist/assets', check_dir=False), name='assets')


    @app.get('/api/state')
    async def state():
        return service.state()

    @app.get('/api/images/{identifier}')
    async def image(identifier: str):
        registered = service.store.image(identifier)
        if not registered:
            raise HTTPException(404, '示意图不存在')
        path, metadata = registered
        return FileResponse(path, media_type=metadata['media_type'], headers={'Cache-Control': 'no-store', 'Content-Disposition': 'inline'})


    @app.post('/api/profile')
    async def profile(profile: Profile):
        if service.coach_status['busy']:
            raise HTTPException(409, '教练正在分析，请等本轮完成后修改个人资料')
        saved = profile.model_dump()
        service.store.put('profile', saved)
        return saved


    @app.post('/api/sync')
    async def sync():
        if service.sync_running:
            return {'accepted': True}
        service.spawn(service.sync_data())
        return {'accepted': True}


    @app.post('/api/chat')
    async def chat(body: Chat):
        if not body.message.strip():
            raise HTTPException(422, '请输入训练诉求')
        if service.coach_status['busy']:
            raise HTTPException(409, '教练正在处理上一条消息')
        service.coach_status.update(busy=True, error=None, phase='检查 DeepSeek 教练连接')
        try:
            await service.refresh_status()
            if not service.coach_status['available']:
                raise HTTPException(503, 'DeepSeek 教练未就绪，请检查服务器模型配置')
            if service.harness_busy:
                raise HTTPException(409, 'DeepSeek 教练正在处理上一条请求')
        except Exception:
            service.coach_status.update(busy=False, phase=None)
            raise
        service.coach_status['phase'] = '正在读取佳明状态'
        service.store.message('user', body.message.strip())
        service.spawn(service.coach_turn())
        return {'accepted': True}

    @app.post('/api/checkin')
    async def checkin(body: CheckIn):
        if service.coach_status['busy']:
            raise HTTPException(409, '教练正在分析，请等本轮完成再更新状态')
        saved = {**body.model_dump(), 'date': today().isoformat(), 'updated_at': now()}
        service.store.put('checkin:' + today().isoformat(), saved)
        return saved

    @app.post('/api/proposals/{identifier}/{action}')
    async def proposal_action(identifier: str, action: str):
        if action not in {'accept', 'dismiss', 'revert'}:
            raise HTTPException(404, '不支持的方案操作')
        if service.coach_status['busy'] or service.sync_running:
            raise HTTPException(409, '正在分析或同步，请完成后再操作方案')
        try:
            return Planning(service.store).decide(identifier, action)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
