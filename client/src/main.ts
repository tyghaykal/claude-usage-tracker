import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { setSessionLostHandler } from './api';
import { router } from './router';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);

setSessionLostHandler(() => {
  void router.push({ name: 'login' });
});

app.mount('#app');
