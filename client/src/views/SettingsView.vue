<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="page-title">Settings</div>
        <div class="page-subtitle">Configure your Jonggrang workspace</div>
      </div>
    </div>

    <!-- Appearance -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-palette" /> Appearance</div>
      <div class="form-group">
        <label>Theme</label>
        <SelectButton
          v-model="themeMode"
          :options="themeModes"
          optionLabel="label"
          optionValue="value"
          @change="onThemeChange"
        >
          <template #option="{ option }">
            <i :class="option.icon" style="margin-right:6px" />{{ option.label }}
          </template>
        </SelectButton>
        <p class="hint">Changes take effect immediately. Default is Night.</p>
      </div>
    </div>

    <!-- Workspace -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-folder-open" /> Workspace</div>
      <div class="form-group">
        <label>Workspace path</label>
        <div class="input-row">
          <InputText v-model="workspacePath" placeholder="/Users/you/.jonggrang/workspace" style="flex:1" />
          <Button :disabled="saving" @click="saveWorkspace" :icon="saving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="saving ? 'Saving…' : 'Save'" />
        </div>
        <div v-if="saveError" class="error-text"><i class="pi pi-times-circle" /> {{ saveError }}</div>
        <div v-if="saveOk" class="ok-text"><i class="pi pi-check-circle" /> Saved!</div>
        <p class="hint">Projects are stored here when importing from git or creating fresh projects.</p>
      </div>
    </div>

    <!-- Sandbox -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-box" /> Docker Sandbox</div>
      <div class="form-group">
        <label>Default Image</label>
        <InputText v-model="sbx.image" placeholder="ghcr.io/porcupine-md/jonggrang-agent" style="width:100%" />
        <p class="hint">Docker image used for all sandbox projects.</p>
      </div>
      <div class="form-group">
        <label>Shell</label>
        <InputText v-model="sbx.shell" placeholder="/bin/bash" style="width:100%" />
        <p class="hint">Shell binary inside the container (e.g. /bin/bash, /bin/sh).</p>
      </div>
      <div class="form-group">
        <label>Docker Network</label>
        <InputText v-model="sbx.network" placeholder="jonggrang" style="width:100%" />
        <p class="hint">Docker network semua sandbox container akan dikoneksikan. Default: jonggrang.</p>
      </div>

      <!-- Volume Mounts -->
      <div class="form-group">
        <div class="vol-header">
          <label>Volume Mounts</label>
          <button class="vol-add-btn" @click="startAddVolume"><i class="pi pi-plus" /> Add</button>
        </div>
        <div class="vol-list" v-if="sbx.volumes.length > 0 || addingVolume">
          <div v-for="vol in sbx.volumes" :key="vol.id" class="vol-row">
            <label class="vol-toggle" :title="vol.enabled ? 'Disable' : 'Enable'">
              <input type="checkbox" :checked="vol.enabled" @change="toggleVolume(vol)" />
            </label>
            <span class="vol-path">
              <span v-if="vol.label" class="vol-label">{{ vol.label }}</span>
              <span class="vol-source">{{ vol.source }}</span>
              <i class="pi pi-arrow-right vol-arrow" />
              <span class="vol-dest">{{ vol.destination }}</span>
            </span>
            <span :class="['vol-badge', `vol-badge--${vol.type || 'bind'}`]">{{ vol.type || 'bind' }}</span>
            <span v-if="vol.readonly" class="vol-badge vol-badge--ro">ro</span>
            <span v-if="vol.error" class="vol-error-icon" :title="vol.error"><i class="pi pi-exclamation-triangle" /></span>
            <button class="vol-del-btn" @click="removeVolume(vol.id)" title="Remove"><i class="pi pi-times" /></button>
          </div>

          <!-- Add form row -->
          <div v-if="addingVolume" class="vol-add-row">
            <input v-model="newVol.source" placeholder="Source path (host)" class="vol-input" />
            <i class="pi pi-arrow-right vol-arrow" />
            <input v-model="newVol.destination" placeholder="Destination (container)" class="vol-input" />
            <select v-model="newVol.type" class="vol-select">
              <option value="bind">bind</option>
              <option value="nfs">nfs</option>
              <option value="tmpfs">tmpfs</option>
            </select>
            <label class="vol-ro-check" title="Read-only">
              <input type="checkbox" v-model="newVol.readonly" /> ro
            </label>
            <button class="vol-confirm-btn" @click="confirmAddVolume"><i class="pi pi-check" /></button>
            <button class="vol-del-btn" @click="cancelAddVolume"><i class="pi pi-times" /></button>
          </div>
        </div>
        <div v-else class="vol-empty">No extra volumes configured.</div>
        <div v-if="volCheckError" class="error-text" style="margin-top:4px"><i class="pi pi-exclamation-triangle" /> {{ volCheckError }}</div>
        <p class="hint">Applied to all sandbox containers. Project-level volumes are added on top.</p>
      </div>

      <div v-if="sbxError" class="error-text"><i class="pi pi-times-circle" /> {{ sbxError }}</div>
      <div v-if="sbxOk" class="ok-text"><i class="pi pi-check-circle" /> Saved!</div>
      <Button :disabled="sbxSaving" @click="saveSandbox" :icon="sbxSaving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="sbxSaving ? 'Saving…' : 'Save'" />
    </div>

    <!-- Local devices (reverse tunnel) -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-desktop" /> Local Devices</div>
      <p class="hint">Machines that run their own code while the agent runs here, reached over a reverse SSH tunnel. Register from the machine itself — <code>jonggrang device register --server &lt;this-host&gt;</code> — then <code>jonggrang tunnel up</code>. Each device gets one reserved port on this server's loopback; <strong>online</strong> means that port is listening right now.</p>

      <div v-if="devErr" class="error-text"><i class="pi pi-times-circle" /> {{ devErr }}</div>
      <div v-else-if="!devices.length" class="hint">No devices registered yet.</div>

      <div v-for="d in devices" :key="d.id" class="dev-row">
        <span class="dev-dot" :class="d.online ? 'dev-dot--on' : 'dev-dot--off'"></span>
        <div class="dev-main">
          <div class="dev-label">{{ d.label }} <span class="dev-id">{{ d.id }}</span></div>
          <div class="dev-meta">
            port {{ d.port }} · {{ d.localuser || '?' }}<span v-if="d.workdir">:{{ d.workdir }}</span>
            · {{ d.online ? 'tunnel up' : 'tunnel down' }}
            <span v-if="d.last_seen"> · last seen {{ d.last_seen }}</span>
          </div>
        </div>
        <Button severity="secondary" text icon="pi pi-trash" :disabled="devBusy" @click="removeDevice(d)" />
      </div>

      <div v-if="agentKey" class="dev-key">
        <label class="ssh-label">This server's agent key — add it to a device's <code>~/.ssh/authorized_keys</code></label>
        <div class="dev-key-body">{{ agentKey }}</div>
      </div>

      <div class="ssh-actions">
        <Button severity="secondary" :disabled="devBusy" @click="loadDevices" :icon="devBusy ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'" label="Refresh" />
      </div>
    </div>

    <!-- Git SSH Key (global) -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-key" /> Git SSH Key (global)</div>
      <p class="hint">Default private key mounted into every sandbox for in-container <code>git push</code>. A per-project key (set in a project's Settings) overrides this; if neither is set, <code>~/.ssh/id_rsa</code> is used. Restart sandboxes after changing.</p>
      <div class="ssh-status">Active: <strong>{{ gssh.source }}</strong> <span v-if="gssh.path" class="ssh-path">{{ gssh.path }}</span></div>
      <div v-if="gssh.fingerprint" class="ssh-fp">{{ gssh.fingerprint }}</div>
      <label class="ssh-label">Paste the global private key</label>
      <textarea
        v-model="gsshInput"
        class="ssh-input"
        rows="4"
        spellcheck="false"
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
      ></textarea>
      <div v-if="gsshError" class="error-text"><i class="pi pi-times-circle" /> {{ gsshError }}</div>
      <div v-if="gsshOk" class="ok-text"><i class="pi pi-check-circle" /> Saved — restart sandboxes to apply</div>
      <div class="ssh-actions">
        <Button :disabled="gsshSaving || !gsshInput.trim()" @click="saveGlobalSshKey" :icon="gsshSaving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="gsshSaving ? 'Saving…' : 'Save key'" />
        <Button severity="secondary" :disabled="gsshSaving || !gssh.has_global_key" @click="clearGlobalSshKey" icon="pi pi-times" label="Remove global key" />
      </div>
    </div>

    <!-- Git host tokens (global) -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-github" /> Git Host Tokens (global)</div>
      <p class="hint">Personal access tokens for the <code>gh</code> (GitHub) and <code>glab</code> (GitLab) CLIs. Injected into every sandbox as <code>GH_TOKEN</code> / <code>GITLAB_TOKEN</code>. Restart sandboxes after changing. Leave blank to keep the current value; clear the field and save to remove.</p>
      <label class="ssh-label">GitHub token (GH_TOKEN) <span v-if="gitTok.has_gh" class="tok-set">● set</span><span v-else class="tok-unset">not set</span></label>
      <input v-model="ghTokenInput" type="password" class="tok-input" spellcheck="false" autocomplete="off" placeholder="ghp_… (leave blank to keep)" />
      <label class="ssh-label">GitLab token (GITLAB_TOKEN) <span v-if="gitTok.has_gitlab" class="tok-set">● set</span><span v-else class="tok-unset">not set</span></label>
      <input v-model="glabTokenInput" type="password" class="tok-input" spellcheck="false" autocomplete="off" placeholder="glpat-… (leave blank to keep)" />
      <div v-if="gitTokError" class="error-text"><i class="pi pi-times-circle" /> {{ gitTokError }}</div>
      <div v-if="gitTokOk" class="ok-text"><i class="pi pi-check-circle" /> Saved — restart sandboxes to apply</div>
      <div class="ssh-actions">
        <Button :disabled="gitTokSaving || (!ghTokenInput && !glabTokenInput)" @click="saveGitTokens" :icon="gitTokSaving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="gitTokSaving ? 'Saving…' : 'Save tokens'" />
      </div>
    </div>

    <!-- Issue sources (GitHub/GitLab issue import) -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-bookmark" /> Issue Sources</div>
      <p class="hint">Repositories listed under the <strong>Issues</strong> menu. Uses the tokens above. Pick the repos you want to import issues from, then save.</p>
      <div v-for="prov in issueProviders" :key="prov.key" class="issrc-block">
        <div class="issrc-head">
          <span class="issrc-prov"><ProviderIcon :provider="prov.key" :size="13" /> {{ prov.label }}</span>
          <span v-if="!prov.connected" class="tok-unset">token not set</span>
        </div>
        <template v-if="prov.connected">
          <div class="issrc-chips">
            <span v-for="r in issueSources[prov.key]" :key="r" class="issrc-chip">
              {{ r }} <button class="issrc-chip-x" @click="removeSource(prov.key, r)"><i class="pi pi-times" /></button>
            </span>
            <span v-if="!issueSources[prov.key].length" class="issrc-none">none selected</span>
          </div>
          <div class="issrc-search">
            <input v-model="prov.query" :placeholder="`Search ${prov.label} repos or type owner/repo`" @keydown.enter="searchRepos(prov)" />
            <Button size="small" severity="secondary" :disabled="prov.searching" @click="searchRepos(prov)" :icon="prov.searching ? 'pi pi-spin pi-spinner' : 'pi pi-search'" label="Search" />
            <Button size="small" severity="secondary" :disabled="!prov.query.includes('/')" @click="addTyped(prov)" label="Add" />
          </div>
          <div v-if="prov.results.length" class="issrc-results">
            <button v-for="r in prov.results" :key="r.full_name" class="issrc-result" @click="addSource(prov.key, r.full_name)">
              <i class="pi pi-plus" /> {{ r.full_name }} <span v-if="r.private" class="issrc-priv">private</span>
            </button>
          </div>
          <div v-if="prov.error" class="error-text">{{ prov.error }}</div>
        </template>
      </div>
      <div v-if="issrcError" class="error-text"><i class="pi pi-times-circle" /> {{ issrcError }}</div>
      <div v-if="issrcOk" class="ok-text"><i class="pi pi-check-circle" /> Saved!</div>
      <Button :disabled="issrcSaving" @click="saveIssueSources" :icon="issrcSaving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="issrcSaving ? 'Saving…' : 'Save sources'" />
    </div>

    <!-- Object storage (S3-compatible) -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-cloud-upload" /> File Storage (S3)</div>
      <p class="hint">S3-compatible storage for file uploads in <strong>Plan mode</strong> and the <strong>Design studio</strong>. Works with Cloudflare R2, MinIO, AWS S3, or any custom provider — an uploaded file's link is inserted for you. Keys are stored in <code>~/.jonggrang/web/storage.json</code> and never returned by the API.</p>
      <div class="stor-grid">
        <label class="stor-field">Provider
          <select v-model="storage.provider" @change="applyProviderDefaults">
            <option value="none">Disabled</option>
            <option value="r2">Cloudflare R2</option>
            <option value="minio">MinIO</option>
            <option value="custom">Custom (S3-compatible)</option>
          </select>
        </label>
        <label class="stor-field">Endpoint URL
          <input v-model="storage.endpoint" placeholder="https://<account>.r2.cloudflarestorage.com" autocapitalize="off" spellcheck="false" />
        </label>
        <label class="stor-field">Bucket
          <input v-model="storage.bucket" placeholder="my-bucket" autocapitalize="off" spellcheck="false" />
        </label>
        <label class="stor-field">Region
          <input v-model="storage.region" placeholder="auto" autocapitalize="off" spellcheck="false" />
        </label>
        <label class="stor-field">Access Key ID
          <input type="password" v-model="akInput" :placeholder="storage.has_access_key ? '•••••• (set — leave blank to keep)' : ''" autocomplete="off" spellcheck="false" />
        </label>
        <label class="stor-field">Secret Access Key
          <input type="password" v-model="skInput" :placeholder="storage.has_secret_key ? '•••••• (set — leave blank to keep)' : ''" autocomplete="off" spellcheck="false" />
        </label>
        <label class="stor-field stor-wide">Public URL base <span class="stor-opt">(optional — else a 7-day presigned link is used)</span>
          <input v-model="storage.publicUrl" placeholder="https://cdn.example.com" autocapitalize="off" spellcheck="false" />
        </label>
        <label class="stor-check"><input type="checkbox" v-model="storage.forcePathStyle" /> Path-style URLs (needed for MinIO / most custom endpoints)</label>
      </div>
      <div v-if="storError" class="error-text"><i class="pi pi-times-circle" /> {{ storError }}</div>
      <div v-if="storOk" class="ok-text"><i class="pi pi-check-circle" /> {{ storOkMsg }}</div>
      <div class="stor-actions">
        <Button :disabled="storSaving" @click="saveStorage" :icon="storSaving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="storSaving ? 'Saving…' : 'Save'" />
        <Button severity="secondary" :disabled="storTesting || !storage.configured" @click="testStorage" :icon="storTesting ? 'pi pi-spin pi-spinner' : 'pi pi-link'" label="Test connection" />
      </div>
    </div>

    <!-- About -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-info-circle" /> About</div>
      <div class="about-row"><span>Jonggrang Web</span><span class="about-val">Multi-project wrapper</span></div>
      <div class="about-row"><span>API</span><span class="about-val">Express + Socket.io</span></div>
      <div class="about-row"><span>UI</span><span class="about-val">Vue 3 + PrimeVue 4 (Aura)</span></div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import SelectButton from 'primevue/selectbutton';
import ProviderIcon from '../components/ProviderIcon.vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { useTheme } from '../composables/useTheme.js';

const workspace = useWorkspaceStore();

// ── Local devices (reverse tunnel) ──────────────────────────────
const devices = ref([]);
const agentKey = ref('');
const devErr = ref('');
const devBusy = ref(false);

async function loadDevices() {
  devBusy.value = true;
  devErr.value = '';
  try {
    const res = await fetch('/api/devices');
    if (!res.ok) throw new Error(`devices: HTTP ${res.status}`);
    const data = await res.json();
    devices.value = data.devices || [];
    // 404 here just means no device has registered yet, which the empty list
    // already says — don't turn it into an error the user has to read.
    const keyRes = await fetch('/api/devices/agent-key');
    agentKey.value = keyRes.ok ? (await keyRes.json()).pubkey : '';
  } catch (err) {
    devErr.value = err.message;
  } finally {
    devBusy.value = false;
  }
}

async function removeDevice(d) {
  devBusy.value = true;
  try {
    await fetch(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    await loadDevices();
  } catch (err) {
    devErr.value = err.message;
  } finally {
    devBusy.value = false;
  }
}
const { mode: themeMode, setMode } = useTheme();

const themeModes = [
  { label: 'Night', value: 'night', icon: 'pi pi-moon' },
  { label: 'Light', value: 'light', icon: 'pi pi-sun' },
  { label: 'System', value: 'system', icon: 'pi pi-desktop' },
];

function onThemeChange(e) {
  setMode(e.value);
}

const workspacePath = ref('');
const saving = ref(false);
const saveError = ref('');
const saveOk = ref(false);

// ── Object storage (S3-compatible) ──
const storage = reactive({ provider: 'none', endpoint: '', bucket: '', region: 'auto', publicUrl: '', forcePathStyle: true, has_access_key: false, has_secret_key: false, configured: false });
const akInput = ref('');
const skInput = ref('');
const storSaving = ref(false);
const storTesting = ref(false);
const storError = ref('');
const storOk = ref(false);
const storOkMsg = ref('');
function applyProviderDefaults() {
  if (storage.provider === 'r2') { storage.region = storage.region || 'auto'; storage.forcePathStyle = true; }
  else if (storage.provider === 'minio') { storage.forcePathStyle = true; }
}
async function loadStorage() {
  try { const r = await fetch('/api/storage/config'); if (r.ok) Object.assign(storage, await r.json()); } catch {}
}
async function saveStorage() {
  storSaving.value = true; storError.value = ''; storOk.value = false;
  try {
    const body = {
      provider: storage.provider, endpoint: storage.endpoint.trim(), bucket: storage.bucket.trim(),
      region: (storage.region || '').trim(), publicUrl: (storage.publicUrl || '').trim(), forcePathStyle: storage.forcePathStyle,
    };
    if (akInput.value) body.accessKeyId = akInput.value.trim();
    if (skInput.value) body.secretAccessKey = skInput.value.trim();
    const r = await fetch('/api/storage/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Save failed');
    Object.assign(storage, d); akInput.value = ''; skInput.value = '';
    storOkMsg.value = 'Saved!'; storOk.value = true; setTimeout(() => { storOk.value = false; }, 3000);
  } catch (e) { storError.value = e.message; } finally { storSaving.value = false; }
}
async function testStorage() {
  storTesting.value = true; storError.value = ''; storOk.value = false;
  try {
    const r = await fetch('/api/storage/test', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || 'Connection failed');
    storOkMsg.value = 'Connection OK — bucket reachable'; storOk.value = true; setTimeout(() => { storOk.value = false; }, 3000);
  } catch (e) { storError.value = e.message; } finally { storTesting.value = false; }
}

const sbx = reactive({ image: '', shell: '', network: '', volumes: [] });
const sbxSaving = ref(false);
const sbxError = ref('');
const sbxOk = ref(false);

const addingVolume = ref(false);
const newVol = reactive({ source: '', destination: '', type: 'bind', readonly: false });
const volCheckError = ref('');

const gssh = reactive({ source: 'none', path: null, has_global_key: false, fingerprint: '' });
const gsshInput = ref('');
const gsshSaving = ref(false);
const gsshError = ref('');
const gsshOk = ref(false);

const gitTok = reactive({ has_gh: false, has_gitlab: false });
const ghTokenInput = ref('');
const glabTokenInput = ref('');
const gitTokSaving = ref(false);
const gitTokError = ref('');
const gitTokOk = ref(false);

// Issue sources (feature #55) — repos to list under the Issues menu.
const issueSources = reactive({ github: [], gitlab: [] });
const issueProviders = reactive([
  { key: 'github', label: 'GitHub', icon: 'pi pi-github', connected: false, query: '', results: [], searching: false, error: '' },
  { key: 'gitlab', label: 'GitLab', icon: 'pi pi-gitlab', connected: false, query: '', results: [], searching: false, error: '' },
]);
const issrcSaving = ref(false);
const issrcOk = ref(false);
const issrcError = ref('');

async function loadIssueConnections() {
  try {
    const r = await fetch('/api/issues/connections');
    if (!r.ok) return;
    const d = await r.json();
    issueProviders[0].connected = !!d.has_gh;
    issueProviders[1].connected = !!d.has_gitlab;
    issueSources.github = d.sources?.github || [];
    issueSources.gitlab = d.sources?.gitlab || [];
  } catch {}
}

async function searchRepos(prov) {
  prov.error = ''; prov.searching = true;
  try {
    const r = await fetch(`/api/issues/repos?provider=${prov.key}&q=${encodeURIComponent(prov.query.trim())}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Search failed');
    prov.results = d.repos || [];
    if (!prov.results.length) prov.error = 'No matching repos.';
  } catch (e) { prov.error = e.message; prov.results = []; } finally { prov.searching = false; }
}

function addSource(key, full) {
  if (full && !issueSources[key].includes(full)) issueSources[key].push(full);
  const prov = issueProviders.find(p => p.key === key);
  if (prov) { prov.results = []; prov.error = ''; }
}

function addTyped(prov) {
  const v = prov.query.trim();
  if (v.includes('/')) { addSource(prov.key, v); prov.query = ''; }
}

function removeSource(key, full) {
  issueSources[key] = issueSources[key].filter(r => r !== full);
}

async function saveIssueSources() {
  issrcSaving.value = true; issrcError.value = ''; issrcOk.value = false;
  try {
    const r = await fetch('/api/issues/sources', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ github: issueSources.github, gitlab: issueSources.gitlab }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Save failed');
    issrcOk.value = true; setTimeout(() => { issrcOk.value = false; }, 2000);
  } catch (e) { issrcError.value = e.message; } finally { issrcSaving.value = false; }
}

onMounted(async () => {
  loadDevices();
  await workspace.fetch();
  workspacePath.value = workspace.path;
  try {
    const res = await fetch('/api/settings/sandbox');
    if (res.ok) {
      const d = await res.json();
      sbx.image = d.image || '';
      sbx.shell = d.shell || '';
      sbx.network = d.network || '';
      sbx.volumes = Array.isArray(d.volumes) ? d.volumes : [];
    }
  } catch {}
  await loadGlobalSshKey();
  try {
    const r = await fetch('/api/settings/git-tokens');
    if (r.ok) Object.assign(gitTok, await r.json());
  } catch {}
  await loadIssueConnections();
  await loadStorage();
});

async function saveGitTokens() {
  gitTokSaving.value = true; gitTokError.value = ''; gitTokOk.value = false;
  try {
    const body = {};
    if (ghTokenInput.value) body.GH_TOKEN = ghTokenInput.value;
    if (glabTokenInput.value) body.GITLAB_TOKEN = glabTokenInput.value;
    const r = await fetch('/api/settings/git-tokens', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Save failed');
    Object.assign(gitTok, d);
    ghTokenInput.value = ''; glabTokenInput.value = '';
    loadIssueConnections();
    gitTokOk.value = true; setTimeout(() => { gitTokOk.value = false; }, 3000);
  } catch (e) {
    gitTokError.value = e.message;
  } finally {
    gitTokSaving.value = false;
  }
}

async function loadGlobalSshKey() {
  try {
    const r = await fetch('/api/settings/ssh-key');
    if (r.ok) Object.assign(gssh, await r.json());
  } catch {}
}

async function saveGlobalSshKey() {
  gsshSaving.value = true; gsshError.value = ''; gsshOk.value = false;
  try {
    const r = await fetch('/api/settings/ssh-key', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: gsshInput.value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Failed to save key');
    Object.assign(gssh, d); gsshInput.value = ''; gsshOk.value = true;
  } catch (e) { gsshError.value = e.message; } finally { gsshSaving.value = false; }
}

async function clearGlobalSshKey() {
  gsshSaving.value = true; gsshError.value = ''; gsshOk.value = false;
  try {
    const r = await fetch('/api/settings/ssh-key', { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Failed');
    Object.assign(gssh, d);
  } catch (e) { gsshError.value = e.message; } finally { gsshSaving.value = false; }
}

function startAddVolume() {
  newVol.source = '';
  newVol.destination = '';
  newVol.type = 'bind';
  newVol.readonly = false;
  volCheckError.value = '';
  addingVolume.value = true;
}

function cancelAddVolume() {
  addingVolume.value = false;
  volCheckError.value = '';
}

async function confirmAddVolume() {
  volCheckError.value = '';
  if (!newVol.destination) {
    volCheckError.value = 'Destination is required.';
    return;
  }
  if (newVol.type !== 'tmpfs' && !newVol.source) {
    volCheckError.value = 'Source path is required.';
    return;
  }
  // Check source existence (skip for tmpfs)
  if (newVol.type !== 'tmpfs') {
    try {
      const r = await fetch('/api/settings/sandbox/volumes/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: newVol.source }),
      });
      const d = await r.json();
      if (!d.exists) {
        volCheckError.value = `Path not found on host: ${newVol.source}`;
        return;
      }
    } catch {
      volCheckError.value = 'Could not verify path.';
      return;
    }
  }
  sbx.volumes.push({
    id: Date.now().toString(36),
    source: newVol.source,
    destination: newVol.destination,
    type: newVol.type,
    readonly: newVol.readonly,
    enabled: true,
  });
  addingVolume.value = false;
}

function removeVolume(id) {
  sbx.volumes = sbx.volumes.filter(v => v.id !== id);
}

async function toggleVolume(vol) {
  const enabling = !vol.enabled;
  if (enabling && vol.type !== 'tmpfs' && vol.source) {
    try {
      const r = await fetch('/api/settings/sandbox/volumes/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: vol.source }),
      });
      const d = await r.json();
      if (!d.exists) {
        vol.error = `Path not found: ${vol.source}`;
        return;
      }
    } catch {
      vol.error = 'Could not verify path.';
      return;
    }
  }
  vol.error = null;
  vol.enabled = enabling;
}

async function saveSandbox() {
  sbxSaving.value = true;
  sbxError.value = '';
  sbxOk.value = false;
  try {
    const res = await fetch('/api/settings/sandbox', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: sbx.image || '',  // blank → backend applies the version-pinned default
        shell: sbx.shell || '/bin/bash',
        network: sbx.network || 'jonggrang',
        volumes: sbx.volumes,
      }),
    });
    if (!res.ok) throw new Error('Save failed');
    sbxOk.value = true;
    setTimeout(() => { sbxOk.value = false; }, 2000);
  } catch (e) {
    sbxError.value = e.message;
  } finally {
    sbxSaving.value = false;
  }
}

async function saveWorkspace() {
  saving.value = true;
  saveError.value = '';
  saveOk.value = false;
  try {
    await workspace.update(workspacePath.value);
    saveOk.value = true;
    setTimeout(() => { saveOk.value = false; }, 2000);
  } catch (e) {
    saveError.value = e.message;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.settings-card {
  max-width: 540px; margin-bottom: 12px;
  background: var(--jg-card);
  border: 1px solid var(--jg-border);
  border-radius: var(--radius); padding: 20px;
}
.card-title {
  font-size: 11px; font-weight: 600;
  color: var(--jg-text-muted);
  margin-bottom: 16px;
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; gap: 6px;
}
.input-row { display: flex; gap: 8px; }
.hint { font-size: 11px; color: var(--jg-text-faint); margin-top: 8px; }
/* Object-storage config grid */
.stor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin: 12px 0; }
.stor-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--jg-text-faint); }
.stor-field.stor-wide { grid-column: 1 / -1; }
.stor-field input, .stor-field select { background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius); color: var(--jg-text); font-family: monospace; font-size: 12px; padding: 6px 8px; outline: none; }
.stor-field input:focus, .stor-field select:focus { border-color: var(--jg-green); }
.stor-opt { color: var(--jg-text-faint); font-weight: 400; opacity: 0.7; }
.stor-check { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--jg-text-faint); }
.stor-check input { accent-color: var(--jg-green); }
.stor-actions { display: flex; gap: 8px; margin-top: 8px; }
.ok-text { color: var(--jg-green); font-size: 12px; margin-top: 4px; display: flex; align-items: center; gap: 4px; }
.ssh-status { font-size: 12px; color: var(--jg-text-muted); margin: 8px 0 4px; }
.ssh-status strong { color: var(--jg-text); text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
.ssh-path { font-family: monospace; font-size: 11px; color: var(--jg-text-faint); margin-left: 8px; }
.ssh-fp { font-family: monospace; font-size: 10px; color: var(--jg-text-faint); margin-bottom: 8px; word-break: break-all; }
.dev-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--jg-border); }
.dev-row:last-of-type { border-bottom: none; }
.dev-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dev-dot--on { background: var(--jg-green); }
.dev-dot--off { background: var(--jg-text-faint); }
.dev-main { flex: 1; min-width: 0; }
.dev-label { font-size: 12px; color: var(--jg-text); }
.dev-id { font-size: 10px; color: var(--jg-text-faint); font-family: monospace; margin-left: 6px; }
.dev-meta { font-size: 10px; color: var(--jg-text-muted); font-family: monospace; }
.dev-key { margin-top: 10px; }
.dev-key-body {
  font-family: monospace; font-size: 10px; color: var(--jg-text-dim);
  background: var(--jg-hover); border: 1px solid var(--jg-border);
  padding: 6px 8px; word-break: break-all;
}
.ssh-label { display: block; font-size: 11px; color: var(--jg-text-faint); margin: 8px 0 4px; }
.ssh-input {
  width: 100%; box-sizing: border-box; resize: vertical;
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  color: var(--jg-text-muted); font-family: monospace; font-size: 11px; padding: 8px;
}
.ssh-input:focus { outline: none; border-color: var(--jg-green); }
.ssh-actions { display: flex; gap: 8px; margin-top: 8px; }
.tok-input {
  width: 100%; box-sizing: border-box;
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  color: var(--jg-text-muted); font-family: monospace; font-size: 11px; padding: 8px; margin-bottom: 4px;
}
.tok-input:focus { outline: none; border-color: var(--jg-green); }
.tok-set { color: var(--jg-green); font-size: 10px; margin-left: 6px; }
.tok-unset { color: var(--jg-text-faint); font-size: 10px; margin-left: 6px; }

/* Issue sources */
.issrc-block { margin: 10px 0 14px; }
.issrc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.issrc-prov { font-size: 11px; font-weight: 600; color: var(--jg-text-muted); display: flex; align-items: center; gap: 5px; }
.issrc-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.issrc-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-family: monospace; color: var(--jg-text); background: var(--jg-hover); border: 1px solid var(--jg-border); border-radius: 12px; padding: 2px 4px 2px 9px; }
.issrc-chip-x { background: none; border: none; color: var(--jg-text-faint); cursor: pointer; padding: 0 2px; display: flex; }
.issrc-chip-x:hover { color: var(--jg-red); }
.issrc-none { font-size: 11px; color: var(--jg-text-faint); }
.issrc-search { display: flex; gap: 6px; align-items: center; }
.issrc-search input { flex: 1; background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius); color: var(--jg-text); font-family: monospace; font-size: 11px; padding: 6px 8px; outline: none; }
.issrc-search input:focus { border-color: var(--jg-green); }
.issrc-results { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; max-height: 180px; overflow-y: auto; border: 1px solid var(--jg-border); border-radius: var(--radius); }
.issrc-result { display: flex; align-items: center; gap: 6px; background: none; border: none; border-bottom: 1px solid var(--jg-border); color: var(--jg-text-muted); font-family: monospace; font-size: 11px; padding: 6px 8px; cursor: pointer; text-align: left; }
.issrc-result:last-child { border-bottom: none; }
.issrc-result:hover { background: var(--jg-hover); color: var(--jg-green); }
.issrc-priv { font-size: 9px; color: var(--jg-text-faint); border: 1px solid var(--jg-border); border-radius: 8px; padding: 0 5px; margin-left: auto; }
.about-row {
  display: flex; justify-content: space-between;
  font-size: 12px; color: var(--jg-text-muted);
  padding: 6px 0; border-bottom: 1px solid var(--jg-border);
}
.about-row:last-child { border-bottom: none; }
.about-val { color: var(--jg-text); font-size: 12px; }

/* Volume mounts */
.vol-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.vol-header label { font-size: 11px; color: var(--jg-text-faint); }
.vol-add-btn {
  background: none; border: 1px solid var(--jg-border); color: var(--jg-text-muted);
  font-size: 11px; padding: 2px 8px; cursor: pointer; display: flex; align-items: center; gap: 4px;
}
.vol-add-btn:hover { border-color: var(--jg-green); color: var(--jg-green); }
.vol-list { display: flex; flex-direction: column; gap: 2px; }
.vol-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border: 1px solid var(--jg-border);
  font-size: 11px; color: var(--jg-text-muted);
}
.vol-row:hover { background: var(--jg-hover); }
.vol-toggle input[type="checkbox"] { accent-color: var(--jg-green); cursor: pointer; }
.vol-path { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; overflow: hidden; }
.vol-label { font-size: 11px; color: var(--jg-text-muted); white-space: nowrap; flex-shrink: 0; }
.vol-source, .vol-dest { font-family: monospace; font-size: 11px; color: var(--jg-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vol-arrow { font-size: 10px; color: var(--jg-text-faint); flex-shrink: 0; }
.vol-badge {
  font-size: 9px; padding: 1px 5px; border: 1px solid var(--jg-border);
  color: var(--jg-text-faint); white-space: nowrap; flex-shrink: 0;
}
.vol-badge--nfs { border-color: var(--jg-cyan); color: var(--jg-cyan); }
.vol-badge--tmpfs { border-color: var(--jg-yellow, #d4a800); color: var(--jg-yellow, #d4a800); }
.vol-badge--ro { border-color: var(--jg-text-faint); }
.vol-del-btn {
  background: none; border: none; color: var(--jg-text-faint);
  cursor: pointer; padding: 2px 4px; flex-shrink: 0;
}
.vol-del-btn:hover { color: var(--jg-red, #e06c75); }
.vol-confirm-btn {
  background: none; border: none; color: var(--jg-green);
  cursor: pointer; padding: 2px 4px; flex-shrink: 0;
}
.vol-error-icon { color: var(--jg-yellow, #d4a800); cursor: help; }
.vol-empty { font-size: 11px; color: var(--jg-text-faint); padding: 6px 0; }
.vol-add-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border: 1px dashed var(--jg-green);
}
.vol-input {
  flex: 1; min-width: 0; background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-family: monospace; font-size: 11px; padding: 3px 6px; outline: none;
}
.vol-input:focus { border-color: var(--jg-green); }
.vol-select {
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-size: 11px; padding: 3px 4px; outline: none;
}
.vol-ro-check { font-size: 11px; color: var(--jg-text-faint); display: flex; align-items: center; gap: 3px; white-space: nowrap; cursor: pointer; }
.vol-ro-check input { accent-color: var(--jg-green); }
</style>
