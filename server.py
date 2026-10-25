"""One server process, suitable for Docker and an HTTPS reverse proxy."""
import os
import uvicorn

if __name__ == '__main__':
    uvicorn.run('heracles.main:create_app', factory=True,
                host=os.environ.get('HERACLES_HOST', '127.0.0.1'), port=8791,
                proxy_headers=True, forwarded_allow_ips=os.environ.get('FORWARDED_ALLOW_IPS', '127.0.0.1'),
                access_log=False)
