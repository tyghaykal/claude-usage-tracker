import { onBeforeUnmount, onMounted, type Ref } from 'vue';

/** Calls `handler` on any pointerdown outside `target`'s element. */
export function onClickOutside(target: Ref<HTMLElement | null>, handler: () => void): void {
  const onPointerDown = (event: PointerEvent) => {
    const el = target.value;
    if (el && !el.contains(event.target as Node)) handler();
  };
  onMounted(() => document.addEventListener('pointerdown', onPointerDown));
  onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown));
}
