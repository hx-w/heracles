"""FastAPI application composition."""
from contextlib import asynccontextmanager

from fastapi import FastAPI

from heracles.api import install_routes
from heracles.service import CoachService


def create_app():
    service = CoachService()

    @asynccontextmanager
    async def lifespan(app):
        await service.start()
        try:
            yield
        finally:
            await service.stop()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.coach = service
    install_routes(app, service)
    return app
