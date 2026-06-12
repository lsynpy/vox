<template>
  <Step
    title="Welcome to Vox!"
    description="Your server is up and running, let's configure a couple things."
  >
    <Button label="Sounds good!" size="xl" data-pw="submit-welcome" @click="emits('proceed')" />
  </Step>
</template>

<script setup lang="ts">
import Button from '@/components/basic/Button.vue';
import Step from '@/components/initial-setup/Step.vue';

const emits = defineEmits<{
  proceed: [];
}>();
</script>
