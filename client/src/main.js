import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import './assets/main.css';
import '@xterm/xterm/css/xterm.css';
import App from './App.vue';
import router from './router/index.js';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
