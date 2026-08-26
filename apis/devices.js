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

const os = require('os');
const tunnel = require('../lib/tunnel');

module.exports = function register(app, io, _ctx) {
  app.get('/api/devices', async (req, res) => {
    try {
      const devices = await tunnel.listDevicesLive();
      res.json({
        devices,
        agent_pubkey_present: Boolean(safePubkey()),
        port_range: [tunnel.PORT_MIN, tunnel.PORT_MAX],
        // What a device would put in `ssh -R …` to reach this server. Only a
        // guess — this host does not know which name resolves from a laptop's
        // network — so the wizard offers it and lets it be corrected.
        ssh_host_default: `${os.userInfo().username}@${os.hostname()}`,
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

  /**
   * Register a device from the dashboard, by pasting its public key.
   *
   * `jonggrang device register` needs ssh from the device to this server, and
   * jonggrang on this host's non-interactive PATH. Neither is true for a laptop
   * whose only route here is a browser — and neither is needed: the tunnel itself
   * is opened with the DEVICE's key, which is what this authorizes. So the
   * chicken-and-egg (a credential here, to be granted a credential here) goes
   * away, and what is left is one key, pasted.
   *
   * What that key is allowed to do is exactly one thing: listen on the one
   * loopback port reserved for it (`restrict,port-forwarding,permitlisten=…`,
   * forced `command=/bin/false`). No shell, no other port. The dashboard binds to
   * loopback, so reaching this endpoint already means being on this machine.
   */
  app.post('/api/devices', (req, res) => {
    const { pubkey, label, localuser, workdir, platform, ssh_host, id, rotate } = req.body || {};

    const key = tunnel.validatePubkey(pubkey);
    if (key.error) {
      return res.status(400).json({ error: { code: 'INVALID_PUBKEY', message: key.error } });
    }
    if (!localuser || !String(localuser).trim()) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'localuser is required — the account the agent enters the device as.' },
      });
    }
    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'label is required' } });
    }

    let result;
    try {
      result = tunnel.provisionDevice({
        id: id || null,
        label: String(label).trim(),
        pubkey: key.body,
        localuser: String(localuser).trim(),
        workdir: workdir ? String(workdir).trim() : null,
        platform: platform ? String(platform).trim() : null,
        rotate: Boolean(rotate),
      });
    } catch (err) {
      // A key already spoken for is the user's mistake to see, not a server fault.
      const status = err.code === 'PUBKEY_IN_USE' ? 409 : 500;
      return res.status(status).json({
        error: { code: err.code || 'PROVISION_FAILED', message: err.message, device_id: err.device_id },
      });
    }

    const server = (ssh_host && String(ssh_host).trim()) || `${os.userInfo().username}@${os.hostname()}`;
    const code = adoptCode({
      server,
      device_id: result.device_id,
      port: result.port,
      token: result.token,
      server_pubkey: result.server_pubkey,
      localuser: String(localuser).trim(),
      workdir: workdir ? String(workdir).trim() : null,
      label: String(label).trim(),
    });

    io.emit('devices.changed', { added: result.device_id });
    res.status(201).json({
      device_id: result.device_id,
      port: result.port,
      rotated: Boolean(result.rotated),
      // The server's own key, and the fingerprint to compare it against: the
      // device is about to trust this key, and trusting one you cannot see is a
      // habit worth not teaching.
      server_pubkey: result.server_pubkey,
      server_fingerprint: tunnel.keyFingerprint(result.server_pubkey),
      device_fingerprint: tunnel.keyFingerprint(key.body),
      ssh_host: server,
      code,
      command: `jonggrang device adopt ${code}`,
    });
  });

  app.delete('/api/devices/:id', (req, res) => {
    try {
      const result = tunnel.removeDevice(req.params.id);
      if (!result) {
        return res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: 'No such device' } });
      }
      io.emit('devices.changed', { removed: req.params.id });
      res.json({
        ok: true,
        authorized_keys: tunnel.authorizedKeysPath(),
        // The mounts this server let go of, and what only the developer can
        // remove from their own machine.
        unmounted: result.unmounted,
        tunnel_key_revoked: result.tunnel_key_revoked,
        device_side: result.device_side,
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'DEVICES_ERROR', message: err.message } });
    }
  });

  /**
   * One thing to copy instead of five to mistype: base64url JSON behind a version
   * tag, consumed by `jonggrang device adopt`. Not a secret — it names the server,
   * the port, and the public key the device will let back in.
   */
  function adoptCode(payload) {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `jg1_${b64}`;
  }

  // Reading it is fine; creating one on a GET is not, so this does not call
  // ensureServerKey — the key appears when a device registers.
  function safePubkey() {
    try { return require('fs').readFileSync(`${tunnel.serverKeyPath()}.pub`, 'utf8').trim(); }
    catch { return null; }
  }

  return () => {};
};
