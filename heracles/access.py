"""Print the owner's pairing link on demand, never in web request logs."""
import argparse
from pathlib import Path
from urllib.parse import urlsplit

from heracles.storage import DATA

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True, help='Public HTTPS origin, or http://localhost:8791 for local use')
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme not in {'https', 'http'} or not url.netloc or url.query or url.fragment or url.path not in {'', '/'} or url.username:
        parser.error('URL must be a bare HTTP(S) origin')
    key = DATA / 'access-key'
    if not key.is_file():
        parser.error('Start Heracles first so its access key is initialized')
    print(args.url.rstrip('/') + '/?access=' + key.read_text().strip())
