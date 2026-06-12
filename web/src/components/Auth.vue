<template>
  <div class="flex flex-col items-center justify-center bg-ls-50 dark:bg-ds-800">
    <div class="w-[480px] bg-ls-0 dark:bg-ds-900 p-12 rounded-lg shadow">
      <img class="mx-auto h-16 mb-12" src="/assets/logo.svg" alt="Vox" />
      <form name="authForm" class="space-y-6" @submit.prevent="doLogin">
        <InputText
          id="username"
          v-model="username"
          autocomplete="username"
          label="Username"
          :error="badCredentials"
          required
          autofocus
        />
        <InputText
          id="password"
          v-model="password"
          autocomplete="password"
          label="Password"
          :error="badCredentials"
          required
          password
        />
        <div
          v-if="badCredentials"
          data-pw="login-error"
          class="text-red-600 dark:text-red-500 text-sm py-2"
        >
          Incorrect credentials, please try again.
        </div>
        <Button
          label="Sign In"
          type="submit"
          size="xl"
          data-pw="submit-login"
          class="w-full"
          :disabled="!username || !password"
        />
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import Button from '@/components/basic/Button.vue';
import InputText from '@/components/basic/InputText.vue';
import { useUserStore } from '@/stores/user';

const user = useUserStore();

const username = ref('');
const password = ref('');
const badCredentials = ref(false);

async function doLogin() {
  badCredentials.value = false;
  try {
    await user.login(username.value, password.value);
  } catch (e) {
    if (e instanceof Response) {
      if (e.status === 401) {
        badCredentials.value = true;
      }
    } else {
      // Handle other errors
    }
  }
}
</script>
