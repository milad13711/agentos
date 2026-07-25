// Regression coverage for the SOCKS5 proxy path added to src/telegram.js —
// api.telegram.org is DNS-hijacked to a private address from inside Iran
// (confirmed on the production server: even querying 8.8.8.8 directly
// returns the same bogus 10.x address), so TELEGRAM_SOCKS_PROXY routes
// every Telegram API call through a SOCKS5 proxy instead of a direct
// connection. This test proves the tunnel actually carries traffic: it
// stands up a minimal real SOCKS5 server (no external dependency — just
// enough of the protocol to accept a no-auth CONNECT) in front of a real
// HTTPS server, and confirms a request made via requestViaAgent() actually
// arrives at the HTTPS server THROUGH the SOCKS server (not directly).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.AGENTOS_TOKEN_SECRET = 'test-secret';
process.env.AGENTOS_DB_PATH = path.join(os.tmpdir(), `agentos-test-tgproxy-${process.pid}-${Date.now()}.sqlite`);

const { SocksProxyAgent } = require('socks-proxy-agent');
const { requestViaAgent } = require('../src/telegram');

// --- minimal SOCKS5 server: no-auth, CONNECT only ---
function startMinimalSocks5Server(onConnect) {
  const server = net.createServer((client) => {
    client.once('data', () => {
      client.write(Buffer.from([0x05, 0x00])); // version 5, no-auth chosen
      client.once('data', (req) => {
        const atyp = req[3];
        let addr, offset;
        if (atyp === 0x01) {
          addr = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          offset = 8;
        } else if (atyp === 0x03) {
          const len = req[4];
          addr = req.slice(5, 5 + len).toString('utf8');
          offset = 5 + len;
        } else {
          client.end();
          return;
        }
        const port = req.readUInt16BE(offset);
        onConnect(addr, port);
        const upstream = net.connect(port, addr, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.end());
      });
    });
    client.on('error', () => {});
  });
  return server;
}

let certPath, keyPath, httpsServer, socksServer, httpsPort, socksPort;
const socksConnections = [];
let receivedRequests = [];

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-tls-'));
  keyPath = path.join(dir, 'key.pem');
  certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);

  httpsServer = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      receivedRequests.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { via: 'https-server' } }));
    });
  });
  await new Promise((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  httpsPort = httpsServer.address().port;

  socksServer = startMinimalSocks5Server((addr, port) => socksConnections.push(`${addr}:${port}`));
  await new Promise((resolve) => socksServer.listen(0, '127.0.0.1', resolve));
  socksPort = socksServer.address().port;
});

test.after(async () => {
  await new Promise((resolve) => httpsServer.close(resolve));
  await new Promise((resolve) => socksServer.close(resolve));
});

test('requestViaAgent tunnels a real HTTPS request through a real SOCKS5 server', async () => {
  const agent = new SocksProxyAgent(`socks5://127.0.0.1:${socksPort}`);
  const targetUrl = `https://127.0.0.1:${httpsPort}/bottest-token/sendMessage`;

  const result = await requestViaAgent(targetUrl, { chat_id: '123', text: 'hello via proxy' }, agent, {
    ca: fs.readFileSync(certPath),
  });

  assert.deepEqual(result, { ok: true, result: { via: 'https-server' } });
  assert.equal(receivedRequests.length, 1);
  assert.equal(receivedRequests[0].text, 'hello via proxy');
  // Prove it actually went through the SOCKS server, not a direct connection.
  assert.ok(socksConnections.some((c) => c.endsWith(`:${httpsPort}`)), 'the SOCKS server must have seen a CONNECT to the HTTPS server');
});

test('getProxyAgent returns null when TELEGRAM_SOCKS_PROXY is unset, a real agent when set', () => {
  const { getProxyAgent } = require('../src/telegram');
  delete process.env.TELEGRAM_SOCKS_PROXY;
  assert.equal(getProxyAgent(), null);

  process.env.TELEGRAM_SOCKS_PROXY = `socks5://127.0.0.1:${socksPort}`;
  const agent = getProxyAgent();
  assert.ok(agent instanceof SocksProxyAgent);
  delete process.env.TELEGRAM_SOCKS_PROXY;
});
