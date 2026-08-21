'use strict';

// Local-sandbox devices — the server side of
// docs/plans/2026-07-07-local-sandbox-remote-agent.md (P0/P1).
//
// Read-mostly on purpose: a device is registered by the DEVICE, over ssh
// (`jonggrang device register`), because that is the trust path the tunnel needs
// anyway. The dashboard's job here is to show what is registered and which
// tunnels are actually up — the one thing a device cannot tell you about itself,
// since only the server can see whether its reserved loopback port is listening.
//
// The tokens in the registry never leave the server.

const tunnel = require('../lib/tunnel');

module.exports = function register(app, io, _ctx) {
  app.get('/api/devices', async (req, res) => {
    try {
      const devices = await tunnel.listDevicesLive();
      res.json({
        devices,
        agent_pubkey_present: Boolean(safePubkey()),
        port_range: [tunnel.PORT_MIN, tunnel.PORT_MAX],
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'DEVICES_ERROR', message: err.message } });
    }
  });

  // The public half of the server's agent key — what a developer authorizes on
  // their machine. Public by definition; the private half is never exposed.
  app.get('/api/devices/agent-key', (req, res) => {
    const pub = safePubkey();
    if (!pub) {
      return res.status(404).json({
        error: { code: 'NO_AGENT_KEY', message: 'No device agent key yet — it is created on the first registration.' },
      });
    }
    res.json({ pubkey: pub });
  });

  app.delete('/api/devices/:id', (req, res) => {
    try {
      if (!tunnel.removeDevice(req.params.id)) {
        return res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: 'No such device' } });
      }
      io.emit('devices.changed', { removed: req.params.id });
      res.json({ ok: true, authorized_keys: tunnel.authorizedKeysPath() });
    } catch (err) {
      res.status(500).json({ error: { code: 'DEVICES_ERROR', message: err.message } });
    }
  });

  // Reading it is fine; creating one on a GET is not, so this does not call
  // ensureServerKey — the key appears when a device registers.
  function safePubkey() {
    try { return require('fs').readFileSync(`${tunnel.serverKeyPath()}.pub`, 'utf8').trim(); }
    catch { return null; }
  }

  return () => {};
};
