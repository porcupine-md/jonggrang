'use strict';

const os = require('os');
const path = require('path');

function resolveAgentDir() {
  return path.join(os.homedir(), '.jonggrang', 'agent');
}

function resolveAuthPath() {
  return path.join(resolveAgentDir(), 'auth.json');
}

module.exports = { resolveAgentDir, resolveAuthPath };
