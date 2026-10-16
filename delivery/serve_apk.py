from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APK = Path('/workspace/StoreBase/delivery/StoreBase-debug.apk')
PORT = 8766

class Handler(BaseHTTPRequestHandler):
    def respond(self, send_body):
        if self.path != '/StoreBase-debug.apk':
            self.send_error(404)
            return
        if not APK.is_file():
            self.send_error(503)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/vnd.android.package-archive')
        self.send_header('Content-Length', str(APK.stat().st_size))
        self.send_header('Content-Disposition', 'attachment; filename="StoreBase-debug.apk"')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if send_body:
            with APK.open('rb') as f:
                while chunk := f.read(1024 * 1024):
                    self.wfile.write(chunk)

    def do_HEAD(self):
        self.respond(False)

    def do_GET(self):
        self.respond(True)

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.client_address[0], fmt % args), flush=True)

server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
print(f'Serving StoreBase APK on 0.0.0.0:{PORT}', flush=True)
server.serve_forever()
