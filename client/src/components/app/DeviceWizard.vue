<template>
  <Dialog :visible="visible" modal header="Add a device" :style="{ width: '560px' }" :draggable="false"
          @update:visible="close">
    <div class="dw">
      <div class="dw-steps">
        <span v-for="n in 3" :key="n" class="dw-step" :class="{ 'dw-step--on': step >= n }">{{ n }}</span>
      </div>

      <!-- 1. the key, which only the device can produce -->
      <div v-if="step === 1">
        <p class="dw-lead">
          A device runs its own code while the agent runs here. Setup is one key: the machine
          makes it, you paste it, and from then on that key is what opens the tunnel — so this
          machine needs no login on the server at all.
        </p>

        <div class="dw-cmd-label">Run this on the machine you want to add</div>
        <div class="dw-cmd">
          <code>jonggrang device key</code>
          <Button text size="small" :icon="copied === 'key' ? 'pi pi-check' : 'pi pi-copy'"
                  @click="copy('jonggrang device key', 'key')" />
        </div>

        <div class="dw-field">
          <label>Its public key</label>
          <Textarea v-model="pubkey" rows="3" autoResize spellcheck="false"
                    placeholder="ssh-ed25519 AAAAC3Nz… you@your-machine" />
          <div class="dw-hint">One line. This is the public half — never paste a private key.</div>
        </div>

        <div v-if="error" class="dw-error"><i class="pi pi-times-circle" /> {{ error }}</div>
      </div>

      <!-- 2. who the agent becomes over there, and where it works -->
      <div v-else-if="step === 2">
        <div class="dw-field">
          <label>Name</label>
          <InputText v-model="label" placeholder="my-laptop" fluid />
          <div class="dw-hint">Yours to recognise it by.</div>
        </div>

        <div class="dw-field">
          <label>Account on that machine</label>
          <InputText v-model="localuser" placeholder="you" fluid />
          <div class="dw-hint">
            The agent enters as this user and can run what it can run. A dedicated account that
            owns only your projects narrows that; your own account does not.
          </div>
        </div>

        <div class="dw-field">
          <label>Default project directory <span class="dw-opt">optional</span></label>
          <InputText v-model="workdir" placeholder="/Users/you/code/project" fluid />
        </div>

        <div class="dw-field">
          <label>How that machine reaches this server over ssh</label>
          <InputText v-model="sshHost" placeholder="user@host" fluid />
          <div class="dw-hint">
            Used for the tunnel itself. This server guessed <code>{{ sshHostDefault || '—' }}</code>,
            which is only right if that name resolves from the device's network.
          </div>
        </div>

        <div v-if="error" class="dw-error"><i class="pi pi-times-circle" /> {{ error }}</div>
      </div>

      <!-- 3. what the device has to be told back -->
      <div v-else-if="step === 3">
        <div class="dw-done"><i class="pi pi-check-circle" /> Port {{ result.port }} reserved for {{ result.device_id }}</div>

        <div class="dw-cmd-label">Finish on the device</div>
        <div class="dw-cmd dw-cmd--wrap">
          <code>{{ result.command }}</code>
          <Button text size="small" :icon="copied === 'adopt' ? 'pi pi-check' : 'pi pi-copy'"
                  @click="copy(result.command, 'adopt')" />
        </div>
        <div class="dw-cmd dw-cmd--wrap">
          <code>jonggrang tunnel up</code>
          <Button text size="small" :icon="copied === 'up' ? 'pi pi-check' : 'pi pi-copy'"
                  @click="copy('jonggrang tunnel up', 'up')" />
        </div>

        <div class="dw-fp">
          <div class="dw-fp-title">The device is about to trust this server's key</div>
          <div class="dw-fp-row"><span>server</span><code>{{ result.server_fingerprint }}</code></div>
          <div class="dw-fp-row"><span>device</span><code>{{ result.device_fingerprint }}</code></div>
          <div class="dw-hint">
            <code>device adopt</code> prints the server fingerprint before it trusts it — the two
            should match what you see here.
          </div>
        </div>

        <div class="dw-wait">
          <span class="dw-dot" :class="online ? 'dw-dot--on' : 'dw-dot--off'"></span>
          {{ online ? 'Tunnel is up — the device is reachable.' : 'Waiting for the tunnel…' }}
        </div>
      </div>
    </div>

    <template #footer>
      <Button v-if="step === 1" label="Cancel" severity="secondary" @click="close" />
      <Button v-else-if="step === 2" label="Back" severity="secondary" @click="step = 1" />
      <Button v-else label="Done" severity="secondary" @click="close" />

      <Button v-if="step === 1" label="Next" :disabled="!pubkey.trim()" @click="toDetails" />
      <Button v-else-if="step === 2" :disabled="busy || !label.trim() || !localuser.trim()"
              :icon="busy ? 'pi pi-spin pi-spinner' : undefined"
              :label="busy ? 'Reserving…' : 'Reserve a port'" @click="submit" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, reactive, onUnmounted } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';

const props = defineProps({
  visible: { type: Boolean, default: false },
  sshHostDefault: { type: String, default: '' },
});
const emit = defineEmits(['close', 'registered']);

const step = ref(1);
const busy = ref(false);
const error = ref('');
const copied = ref('');

const pubkey = ref('');
const label = ref('');
const localuser = ref('');
const workdir = ref('');
const sshHost = ref('');

const result = reactive({ device_id: '', port: 0, command: '', server_fingerprint: '', device_fingerprint: '' });
const online = ref(false);
let poll = null;

// The key's comment is usually `user@host`, which is exactly the two fields the
// next step asks for. Offering them is not the same as deciding them — both stay
// editable, because a comment is only what the key was labelled with.
function toDetails() {
  error.value = '';
  const comment = pubkey.value.trim().split(/\s+/)[2] || '';
  const [user, host] = comment.includes('@') ? comment.split('@') : ['', ''];
  if (!label.value) label.value = host || '';
  if (!localuser.value) localuser.value = user || '';
  if (!sshHost.value) sshHost.value = props.sshHostDefault || '';
  step.value = 2;
}

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubkey: pubkey.value,
        label: label.value.trim(),
        localuser: localuser.value.trim(),
        workdir: workdir.value.trim() || null,
        ssh_host: sshHost.value.trim() || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      // The pubkey is judged on the server, so its message belongs on the step
      // that owns the field.
      error.value = data?.error?.message || `HTTP ${res.status}`;
      if (data?.error?.code === 'INVALID_PUBKEY') step.value = 1;
      return;
    }
    Object.assign(result, data);
    step.value = 3;
    emit('registered');
    watchForTunnel(data.device_id);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

// The one thing the server can see that the device cannot claim for itself:
// whether its reserved port is listening right now.
function watchForTunnel(deviceId) {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const res = await fetch('/api/devices');
      if (!res.ok) return;
      const { devices = [] } = await res.json();
      const mine = devices.find(d => d.id === deviceId);
      if (mine?.online) {
        online.value = true;
        clearInterval(poll);
        poll = null;
        emit('registered');
      }
    } catch { /* the dashboard is right here; a blip is not worth reporting */ }
  }, 3000);
}

async function copy(text, which) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = which;
    setTimeout(() => { if (copied.value === which) copied.value = ''; }, 1500);
  } catch { /* a browser that refuses the clipboard still shows the text */ }
}

function close() {
  clearInterval(poll);
  poll = null;
  step.value = 1;
  busy.value = false;
  error.value = '';
  pubkey.value = '';
  label.value = '';
  localuser.value = '';
  workdir.value = '';
  sshHost.value = '';
  online.value = false;
  emit('close');
}

onUnmounted(() => clearInterval(poll));
</script>

<style scoped>
.dw { display: flex; flex-direction: column; gap: 0.9rem; }

.dw-steps { display: flex; gap: 0.4rem; }
.dw-step {
  width: 22px; height: 22px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 0.72rem; font-weight: 600;
  background: var(--p-surface-200); color: var(--p-text-muted-color);
}
.dw-step--on { background: var(--p-primary-color); color: var(--p-primary-contrast-color); }

.dw-lead { margin: 0; font-size: 0.85rem; line-height: 1.5; color: var(--p-text-muted-color); }

.dw-cmd-label { font-size: 0.78rem; font-weight: 600; margin-top: 0.2rem; }
.dw-cmd {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  background: var(--p-surface-100); border: 1px solid var(--p-content-border-color);
  border-radius: 6px; padding: 0.35rem 0.35rem 0.35rem 0.6rem;
}
.dw-cmd code { font-size: 0.78rem; word-break: break-all; }
.dw-cmd--wrap code { line-height: 1.4; }

.dw-field { display: flex; flex-direction: column; gap: 0.3rem; }
.dw-field label { font-size: 0.78rem; font-weight: 600; }
.dw-field :deep(textarea) { width: 100%; font-family: var(--font-mono, monospace); font-size: 0.75rem; }
.dw-opt { font-weight: 400; color: var(--p-text-muted-color); }
.dw-hint { font-size: 0.74rem; line-height: 1.45; color: var(--p-text-muted-color); }
.dw-error { font-size: 0.78rem; color: var(--p-red-500); }

.dw-done { font-size: 0.85rem; font-weight: 600; color: var(--p-green-500); }

.dw-fp {
  display: flex; flex-direction: column; gap: 0.25rem;
  border: 1px solid var(--p-content-border-color); border-radius: 6px; padding: 0.55rem 0.65rem;
}
.dw-fp-title { font-size: 0.78rem; font-weight: 600; }
.dw-fp-row { display: flex; gap: 0.5rem; align-items: baseline; }
.dw-fp-row span { font-size: 0.72rem; width: 3.2rem; color: var(--p-text-muted-color); }
.dw-fp-row code { font-size: 0.72rem; word-break: break-all; }

.dw-wait { display: flex; align-items: center; gap: 0.45rem; font-size: 0.8rem; }
.dw-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dw-dot--on { background: var(--p-green-500); }
.dw-dot--off { background: var(--p-surface-400); }
</style>
