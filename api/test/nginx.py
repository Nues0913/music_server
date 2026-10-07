"""Exercise Nginx ACME with a private Pebble CA; never use production Let's Encrypt."""
import http.client
import json
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import time
import uuid

PROJECT = Path(__file__).resolve().parents[2]
DOMAIN = 'music.example.com'
IMAGE = 'nginx:1.30-alpine'
PEBBLE = 'ghcr.io/letsencrypt/pebble:latest'


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def request(port, host, path='/health', *, tls=False, sni=DOMAIN, headers=None, body=b''):
    connection = socket.create_connection(('127.0.0.1', port), timeout=5)
    if tls:
        # Private test CA, generated afresh for this isolated test network.
        connection = ssl._create_unverified_context().wrap_socket(connection, server_hostname=sni)
    certificate = connection.getpeercert(binary_form=True) if tls else None
    with connection:
        fields = {'Host': host, 'Connection': 'close', **(headers or {})}
        if body:
            fields['Content-Length'] = str(len(body))
        method = 'POST' if body else 'GET'
        raw = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in fields.items())
        connection.sendall(raw.encode() + b'\r\n' + body)
        response = http.client.HTTPResponse(connection)
        try:
            response.begin()
        except http.client.RemoteDisconnected:
            return None, b'', certificate
        return response.status, response.read(), certificate


def wait_for(check, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (ConnectionError, ssl.SSLError, http.client.HTTPException):
            pass
        time.sleep(0.2)
    raise AssertionError('Timed out waiting for Nginx / test certificate')


with tempfile.TemporaryDirectory(prefix='music-acme-test-') as temporary:
    fixture = Path(temporary)
    fixture.chmod(0o755)
    identity = uuid.uuid4().hex[:12]
    network = 'music-acme-' + identity
    volume = network + '-state'
    containers = []
    command('docker', 'network', 'create', network)
    command('docker', 'volume', 'create', volume)
    try:
        # CA for the Pebble HTTPS API, not a pre-issued certificate for Nginx.
        quiet = {'check': True, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}
        subprocess.run(['openssl', 'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1',
                        '-subj', '/CN=ACME test root', '-addext', 'basicConstraints=critical,CA:TRUE',
                        '-keyout', str(fixture/'ca.key'), '-out', str(fixture/'ca.crt')], **quiet)
        subprocess.run(['openssl', 'req', '-nodes', '-newkey', 'rsa:2048', '-subj', '/CN=pebble',
                        '-keyout', str(fixture/'pebble.key'), '-out', str(fixture/'pebble.csr')], **quiet)
        (fixture/'extensions').write_text('subjectAltName=DNS:pebble\n')
        subprocess.run(['openssl', 'x509', '-req', '-days', '1', '-in', str(fixture/'pebble.csr'),
                        '-CA', str(fixture/'ca.crt'), '-CAkey', str(fixture/'ca.key'), '-CAcreateserial',
                        '-extfile', str(fixture/'extensions'), '-out', str(fixture/'pebble.crt')], **quiet)
        (fixture/'pebble.json').write_text(json.dumps({'pebble': {
            'listenAddress': '0.0.0.0:14000', 'managementListenAddress': '0.0.0.0:15000',
            'certificate': '/fixture/pebble.crt', 'privateKey': '/fixture/pebble.key',
            'httpPort': 80, 'tlsPort': 443, 'certificateValidityPeriod': 60, 'externalAccountBindingRequired': False,
            'profiles': {'default': {'description': 'Short test certificate', 'validityPeriod': 60}},
        }}))
        ca = command('docker', 'run', '--rm', '-d', '--network', network, '--network-alias', 'pebble',
                     '-e', 'PEBBLE_VA_NOSLEEP=1', '-e', 'PEBBLE_WFE_NONCEREJECT=0',
                     '-v', f'{fixture}:/fixture:ro', PEBBLE, '-config', '/fixture/pebble.json')
        containers.append(ca)
        (fixture/'audio').mkdir()
        (fixture/'audio/test.mp3').write_bytes(b'0123456789')
        (fixture/'backend.conf').write_text('''server {
            listen 3000;
            client_max_body_size 257m;
            location / { return 200 "$http_host|$http_x_forwarded_proto|$http_x_real_ip"; }
            location = /stream { add_header X-Accel-Redirect /protected-audio/test.mp3; return 200; }
        }''')

        def start_nginx(domain):
            args = ['docker', 'run', '--rm', '-d', '--memory', '48m', '--memory-swap', '48m', '--pids-limit', '32', '--network', network,
                    '-p', '127.0.0.1::80', '-p', '127.0.0.1::443']
            if domain:
                args += ['--network-alias', domain]
            for key, value in {'SERVER_NAME': domain, 'NGINX_BIND': '0.0.0.0',
                               'API_UPSTREAM': '127.0.0.1:3000', 'AUDIO_ROOT': '/srv/music-audio',
                               'ACME_DIRECTORY': 'https://pebble:14000/dir',
                               'ACME_TRUSTED_CERT': '/fixture/ca.crt'}.items():
                args += ['-e', f'{key}={value}']
            for source, target in [
                (PROJECT/'nginx/nginx.conf', '/etc/nginx/nginx.conf'),
                (PROJECT/'nginx', '/opt/music-nginx'),
                (PROJECT/'nginx/docker-start.sh', '/docker-entrypoint.d/40-music-config.sh'),
                (PROJECT/'nginx/locations.conf', '/etc/nginx/snippets/music-locations.conf'),
                (fixture/'backend.conf', '/etc/nginx/conf.d/backend.conf'),
                (fixture/'audio', '/srv/music-audio'), (fixture, '/fixture'),
            ]:
                args += ['-v', f'{source}:{target}:ro']
            args += ['-v', f'{volume}:/var/lib/nginx/acme', IMAGE]
            container = command(*args)
            containers.append(container)
            http_port = int(command('docker', 'port', container, '80/tcp').split(':')[-1])
            https_port = int(command('docker', 'port', container, '443/tcp').split(':')[-1])
            return container, http_port, https_port

        nginx, port, _ = start_nginx('')
        wait_for(lambda: request(port, '192.168.1.10')[0] == 200)
        assert request(port, '127.0.0.1')[0] == 200
        command('docker', 'exec', nginx, 'nginx', '-t')
        command('docker', 'rm', '-f', nginx)
        containers.remove(nginx)
        print('PASS: no domain accepts local IP over HTTP', flush=True)

        nginx, http_port, https_port = start_nginx(DOMAIN)
        wait_for(lambda: request(http_port, DOMAIN)[0] == 200)
        assert request(http_port, '127.0.0.1')[0] is None
        assert request(http_port, 'other.example.com')[0] is None
        try:
            issued = wait_for(lambda: request(https_port, DOMAIN, tls=True), timeout=60)
        except AssertionError:
            print(command('docker', 'logs', ca))
            print(command('docker', 'logs', nginx))
            raise
        assert issued[0] == 200 and issued[1].startswith((DOMAIN+'|https|').encode()), issued
        original_certificate = issued[2]
        pem = ssl.DER_cert_to_PEM_cert(original_certificate)
        (fixture/'issued.pem').write_text(pem)
        metadata = command('openssl', 'x509', '-in', str(fixture/'issued.pem'), '-noout', '-issuer', '-dates', '-ext', 'subjectAltName')
        assert 'Pebble' in metadata and DOMAIN in metadata, metadata
        print(metadata, flush=True)
        assert request(https_port, 'other.example.com', tls=True)[0] is None
        try:
            request(https_port, DOMAIN, tls=True, sni='other.example.com')
        except ssl.SSLError:
            pass
        else:
            raise AssertionError('Unknown TLS name was accepted')
        for port, tls in [(http_port, False), (https_port, True)]:
            options = {'tls': tls}
            assert request(port, DOMAIN, '/protected-audio/test.mp3', **options)[0] == 404
            assert request(port, DOMAIN, '/stream', **options)[1] == b'0123456789'
            ranged = request(port, DOMAIN, '/stream', headers={'Range': 'bytes=2-5'}, **options)
            assert ranged[0] == 206 and ranged[1] == b'2345'
            assert request(port, DOMAIN, '/v1/songs', body=b'a'*2048, **options)[0] == 200
        print('PASS: ACME HTTP-01 issuance, both HTTP/HTTPS, domain rejection, upload and Range', flush=True)
        command('docker', 'rm', '-f', nginx)
        containers.remove(nginx)
        nginx, _, https_port = start_nginx(DOMAIN)
        restored = wait_for(lambda: request(https_port, DOMAIN, tls=True))
        assert restored[2] == original_certificate, 'Certificate was not restored after container recreation'
        print('PASS: certificate persisted across container recreation', flush=True)
        try:
            renewed = wait_for(lambda: (result if result[2] != original_certificate else None)
                           if (result := request(https_port, DOMAIN, tls=True))[0] == 200 else None, timeout=150)
        except AssertionError:
            print(command('docker', 'logs', ca))
            print(command('docker', 'logs', nginx))
            raise
        assert renewed[2] != original_certificate
        print('PASS: short-lived certificate renewed automatically without restarting Nginx', flush=True)
    finally:
        for container in reversed(containers):
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, check=False)
        command('docker', 'volume', 'rm', volume)
        command('docker', 'network', 'rm', network)
