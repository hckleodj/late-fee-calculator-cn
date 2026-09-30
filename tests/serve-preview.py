"""LAN-only isolated HTTPS preview. Serve runtime + fictional fixture, never source storage or keys."""
import http.server
import ssl
import sys
from pathlib import Path
from urllib.parse import urlsplit, unquote
ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {'/', '/index.html', '/rental-calculation.js', '/rental-document.js', '/rental-document.css', '/rental-export.js', '/installment-ledger.js', '/backup-state.js', '/local-snapshots.js', '/backup-transfer.js', '/migration-transfer.js', '/vendor/html2canvas-1.4.1.min.js', '/vendor/jspdf-4.2.1.umd.min.js', '/tests/preview.html', '/tests/fixtures/battery-demo.json'}
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def do_GET(self):
        if unquote(urlsplit(self.path).path) not in ALLOWED: return self.send_error(404)
        super().do_GET()
    def do_HEAD(self):
        if unquote(urlsplit(self.path).path) not in ALLOWED: return self.send_error(404)
        super().do_HEAD()
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        super().end_headers()
http_only='--http' in sys.argv
server=http.server.ThreadingHTTPServer(('127.0.0.1',8877) if http_only else ('0.0.0.0',8878),Handler)
if not http_only:
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(ROOT/'output/preview-tls/cert.pem',ROOT/'output/preview-tls/key.pem')
    server.socket=context.wrap_socket(server.socket,server_side=True)
print('Isolated HTTP localhost:8877' if http_only else 'Isolated HTTPS LAN:8878',flush=True)
server.serve_forever()
