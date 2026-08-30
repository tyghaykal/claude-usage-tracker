<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import SearchableSelect from './SearchableSelect.vue';
import type { UserDirectoryEntry } from '../types';

export interface FilterModel {
  project: string;
  userId: string;
  model: string;
  dateFrom: string;
  dateTo: string;
}

const props = defineProps<{ modelValue: FilterModel }>();
const emit = defineEmits<{ 'update:modelValue': [FilterModel] }>();

const projects = ref<string[]>([]);
const models = ref<string[]>([]);
const users = ref<UserDirectoryEntry[]>([]);

const local = ref<FilterModel>({ ...props.modelValue });
watch(
  () => props.modelValue,
  (next) => {
    local.value = { ...next };
  },
);

onMounted(async () => {
  const [facets, userList] = await Promise.all([
    api<{ projects: string[]; models: string[] }>('/usage-logs/facets'),
    api<{ users: UserDirectoryEntry[] }>('/me/directory'),
  ]);
  projects.value = facets.projects;
  models.value = facets.models;
  users.value = userList.users;
});

const apply = () => emit('update:modelValue', { ...local.value });

function reset() {
  local.value = { project: '', userId: '', model: '', dateFrom: '', dateTo: '' };
  apply();
}
</script>

<template>
  <form class="card grid gap-3 sm:grid-cols-2 lg:grid-cols-6" @submit.prevent="apply">
    <div class="lg:col-span-2">
      <label class="label" for="f-project">Project</label>
      <SearchableSelect id="f-project" v-model="local.project" :options="projects" />
    </div>

    <div>
      <label class="label" for="f-user">Developer</label>
      <select id="f-user" v-model="local.userId" class="input">
        <option value="">Anyone</option>
        <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
      </select>
    </div>

    <div>
      <label class="label" for="f-model">Model</label>
      <select id="f-model" v-model="local.model" class="input">
        <option value="">Any</option>
        <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
      </select>
    </div>

    <div>
      <label class="label" for="f-from">From</label>
      <input id="f-from" v-model="local.dateFrom" class="input" type="date" />
    </div>

    <div>
      <label class="label" for="f-to">To</label>
      <input id="f-to" v-model="local.dateTo" class="input" type="date" />
    </div>

    <div class="flex items-end gap-2 sm:col-span-2 lg:col-span-6">
      <button class="btn-primary" type="submit">Apply filters</button>
      <button class="btn-secondary" type="button" @click="reset">Reset</button>
    </div>
  </form>
</template>
