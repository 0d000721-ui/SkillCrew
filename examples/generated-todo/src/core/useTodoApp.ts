import { useSyncExternalStore } from 'react';
import type { AppViewProps } from '../contracts';
import { createTodoStore } from './store';

let store: ReturnType<typeof createTodoStore> | null = null;

function currentStore() {
  if (!store) store = createTodoStore(window.localStorage);
  return store;
}

export function useTodoApp(): AppViewProps {
  const active = currentStore();
  const state = useSyncExternalStore(active.subscribe, active.getState, active.getState);
  return {
    state,
    addTodo: active.addTodo,
    editTodo: active.editTodo,
    toggleTodo: active.toggleTodo,
    deleteTodo: active.deleteTodo,
    addCategory: active.addCategory,
    renameCategory: active.renameCategory,
    deleteCategory: active.deleteCategory,
    moveTodo: active.moveTodo,
  };
}
