"""Proof only: the REAL Ash OS hub backend (ashos.Hub from exo-cc-studio), run in-process against a throwaway ledger,
registry and memory, served with the same /api/ash-hub-* and /api/ash-hub-events shapes the app talks to.

- The code is exported read-only from exo-cc-studio's committed HEAD (`git archive`) into a temp folder: the live
  checkout, Ash's ledger, memory and boards are never touched.
- No model and no Grok bot: every model entry point raises, and `--forbid-models` makes a call fail the run. The
  script prints `models_called=N` on exit so a test can assert it stayed 0.
- `--dev` adds CORS and GET /__stub/token so hub-dev.html (?stub=<url>) can read it, like scripts/hub-stub-server.mjs.

    python3 scripts/proof/ashos-isolated.py --port 18901 --studio ~/Projects/exo-cc-studio [--dev]
"""
import argparse, json, os, secrets, subprocess, sys, tarfile, io, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, required=True)
ap.add_argument('--studio', default=str(Path.home() / 'Projects/exo-cc-studio'))
ap.add_argument('--dev', action='store_true')
args = ap.parse_args()

tmp = Path(tempfile.mkdtemp(prefix='ashos-proof-'))
code = tmp / 'code'
code.mkdir()
blob = subprocess.run(['git', '-C', args.studio, 'archive', '--format=tar', 'HEAD', 'ashos', 'studio'],
                      check=True, capture_output=True).stdout
tarfile.open(fileobj=io.BytesIO(blob)).extractall(code)
head = subprocess.run(['git', '-C', args.studio, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
os.environ.update(ASHOS_DATA=str(tmp / 'inbox'), ASHOS_DB=str(tmp / 'l.db'), ASHOS_MEMORY_ROOT=str(tmp / 'mem'),
                  ASHOS_PROJECTS=str(tmp / 'projects'), ASHOS_LOCAL_PROJECTS=str(tmp / 'local-projects'),
                  ASHOS_CODE_HOME=str(tmp / 'code-home'), HOME=str(tmp / 'home'))
for d in ('inbox', 'mem', 'projects', 'local-projects', 'code-home', 'home'):
    (tmp / d).mkdir()
sys.dont_write_bytecode = True
sys.path.insert(0, str(code))

from ashos import boards, brief, llm, sweep            # noqa: E402
from ashos.core import AshOS                            # noqa: E402
from ashos.hub import Hub                               # noqa: E402
from ashos.ledger import Ledger                         # noqa: E402
from ashos.registry import Registry                     # noqa: E402

models_called = 0
def no_model(*a, **k):
    global models_called
    models_called += 1
    raise llm.LLMError('proof run: no model or bot may be called')
for name in dir(llm):
    if callable(getattr(llm, name)) and not name[0].isupper() and name not in ('LLMError',) and not name.startswith('_'):
        try: setattr(llm, name, no_model)
        except Exception: pass
brief.job_reports = lambda *a, **k: []
brief._held_cards = lambda: []
sweep.HOME = tmp / 'home'
boards.cards = lambda *a, **k: []
def board_path(slug):
    p = tmp / 'boards' / f'{slug}.db'; p.parent.mkdir(exist_ok=True); p.touch(); return p
boards.board_path = board_path

ledger = Ledger(db=tmp / 'l.db', data=tmp / 'inbox')
ledger.set_meta('doctor_last', {'at': time.time() + 86400, 'level': 'ok', 'summary': 'ok', 'problems': []})
registry = Registry(tmp / 'projects', local=tmp / 'local-projects')
ash = AshOS(ledger, registry, runner=no_model)
try:
    from studio.memory import ProjectMemory
    ash.intake.memory_factory = lambda p: ProjectMemory(tmp / 'mem', p)
except Exception:
    pass
hub = Hub(ash)
hub.jobs.wake_studio = lambda *a, **k: None          # no studio lead to wake: nothing outside this process
token = secrets.token_hex(16)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def cors(self):
        if args.dev:
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin') or '*')
            self.send_header('Access-Control-Allow-Headers', 'authorization, content-type')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.cors()
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def authed(self):
        return self.headers.get('Authorization', '') == 'Bearer ' + token
    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query); one = lambda k, d=None: (q.get(k) or [d])[0]
        if args.dev and u.path == '/__stub/token':
            return self.reply(200, {'token': token})
        if u.path == '/__proof/state':
            return self.reply(200, {'models_called': models_called, 'ashos_head': head})
        if u.path != '/api/ash-hub-events':
            return self.reply(404, {'ok': False, 'error': 'Unknown endpoint'})
        if not self.authed():
            return self.reply(401, {'ok': False, 'error': 'Studio authorization required'})
        after = int(self.headers.get('Last-Event-ID') or one('after', 0) or 0)
        if one('stream') == '1' or 'text/event-stream' in self.headers.get('Accept', ''):
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store'); self.send_header('Connection', 'close'); self.cors(); self.end_headers()
            try:
                for chunk in hub.sse(after, None, float(one('max_seconds', 300) or 300), alive=lambda: True):
                    self.wfile.write(chunk); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True
            return
        self.reply(200, {'ok': True, 'result': hub.wait_events(after, float(one('timeout', 0) or 0))})
    def do_POST(self):
        if not self.authed():
            return self.reply(401, {'ok': False, 'error': 'Studio authorization required'})
        try:
            value = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
            if not isinstance(value, dict): raise ValueError('Object required')
            if not self.path.startswith('/api/ash-hub-'): raise ValueError('Unknown endpoint')
            action = self.path[len('/api/ash-'):]          # hub-<name>, as service.py checks it
            caller = Hub.clean_caller(value.pop('_caller')) if '_caller' in value else None
            if caller: hub.check_lane(action, caller, value)
            result = hub.action(action[4:], value, caller)
            if caller: hub.record_act(caller, action, value, result)
            self.reply(200, {'ok': True, 'result': result})
        except PermissionError as e:
            self.reply(403, {'ok': False, 'error': str(e)})
        except Exception as e:
            self.reply(400, {'ok': False, 'error': str(e)})

server = ThreadingHTTPServer(('127.0.0.1', args.port), H)
print(json.dumps({'ready': True, 'port': args.port, 'ashos_head': head, 'tmp': str(tmp)}), flush=True)
try:
    server.serve_forever()
finally:
    print(f'models_called={models_called}', flush=True)
