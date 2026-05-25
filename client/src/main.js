import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import { definePreset } from '@primevue/themes';
import Tooltip from 'primevue/tooltip';
import 'primeicons/primeicons.css';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import './assets/main.css';
import '@xterm/xterm/css/xterm.css';
import App from './App.vue';
import router from './router/index.js';

// jonggrang.dev surface palette — dark blue-gray, oklch(L 0.014 245) scale
const jgSurface = {
  0:   '#ffffff',
  50:  '#a0aab8',
  100: '#7e8aa0',
  200: '#596480',
  300: '#374558',
  400: '#2f3a4c',
  500: '#273140',
  600: '#202938',
  700: '#1a2230',
  800: '#141b24',
  900: '#0f1520',
  950: '#0b1019',
};

const JonggrangPreset = definePreset(Aura, {
  primitive: { jg: jgSurface },
  semantic: {
    primary: {
      50:  '{green.50}',
      100: '{green.100}',
      200: '{green.200}',
      300: '{green.300}',
      400: '{green.400}',
      500: '{green.500}',
      600: '{green.600}',
      700: '{green.700}',
      800: '{green.800}',
      900: '{green.900}',
      950: '{green.950}',
    },
    colorScheme: {
      light: { surface: { ...jgSurface, 50: '{jg.50}', 100: '{jg.100}', 200: '{jg.200}', 300: '{jg.300}', 400: '{jg.400}', 500: '{jg.500}', 600: '{jg.600}', 700: '{jg.700}', 800: '{jg.800}', 900: '{jg.900}', 950: '{jg.950}' } },
      dark:  { surface: { ...jgSurface, 50: '{jg.50}', 100: '{jg.100}', 200: '{jg.200}', 300: '{jg.300}', 400: '{jg.400}', 500: '{jg.500}', 600: '{jg.600}', 700: '{jg.700}', 800: '{jg.800}', 900: '{jg.900}', 950: '{jg.950}' } },
    },
  },
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(PrimeVue, {
  theme: {
    preset: JonggrangPreset,
    options: {
      darkModeSelector: 'html.dark',
    }
  }
});
app.directive('tooltip', Tooltip);
app.mount('#app');
