import type { Category, TodoState, TodoStore } from '../contracts';

const STORAGE_KEY = 'skillcrew.todos.v1';

function emptyState(): TodoState {
  return { version: 1, categories: [{ id: 'inbox', name: '收件箱' }], todos: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidState(value: unknown): value is TodoState {
  if (!isRecord(value) || value.version !== 1 ||
      !Array.isArray(value.categories) || !Array.isArray(value.todos)) return false;

  const ids = new Set<string>();
  const categoryIds = new Set<string>();
  for (const category of value.categories) {
    if (!isRecord(category) || !nonBlank(category.id) ||
        !nonBlank(category.name) || ids.has(category.id)) return false;
    ids.add(category.id);
    categoryIds.add(category.id);
  }
  if (!categoryIds.has('inbox')) return false;

  for (const todo of value.todos) {
    if (!isRecord(todo) || !nonBlank(todo.id) || !nonBlank(todo.title) ||
        !nonBlank(todo.categoryId) || typeof todo.done !== 'boolean' ||
        ids.has(todo.id) || !categoryIds.has(todo.categoryId)) return false;
    ids.add(todo.id);
  }
  return true;
}

function loadState(storage: Storage): TodoState {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved === null) return emptyState();
  try {
    const parsed: unknown = JSON.parse(saved);
    if (!isValidState(parsed)) return emptyState();
    return {
      version: 1,
      categories: parsed.categories.map(({ id, name }) => ({ id, name })),
      todos: parsed.todos.map(({ id, title, categoryId, done }) =>
        ({ id, title, categoryId, done })),
    };
  } catch {
    return emptyState();
  }
}

function requiredText(value: string, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`${label}不能为空`);
  return trimmed;
}

export function createTodoStore(storage: Storage): TodoStore {
  let state = loadState(storage);
  let serial = 0;
  const listeners = new Set<() => void>();

  function newId(): string {
    let id: string;
    do {
      const random = globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      id = `${random}-${serial++}`;
    } while (state.categories.some(category => category.id === id) ||
             state.todos.some(todo => todo.id === id));
    return id;
  }

  function requireCategory(id: string): Category {
    const category = state.categories.find(item => item.id === id);
    if (!category) throw new Error('分类不存在');
    return category;
  }

  function requireTodo(id: string) {
    const todo = state.todos.find(item => item.id === id);
    if (!todo) throw new Error('待办不存在');
    return todo;
  }

  function commit(candidate: TodoState): void {
    if (!isValidState(candidate)) throw new Error('待办状态无效');
    storage.setItem(STORAGE_KEY, JSON.stringify(candidate));
    state = candidate;
    for (const listener of [...listeners]) listener();
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    addTodo(title: string, categoryId: string = 'inbox') {
      const cleanTitle = requiredText(title, '待办标题');
      requireCategory(categoryId);
      commit({
        ...state,
        todos: [...state.todos, { id: newId(), title: cleanTitle, categoryId, done: false }],
      });
    },
    editTodo(id: string, title: string) {
      const cleanTitle = requiredText(title, '待办标题');
      const current = requireTodo(id);
      if (current.title === cleanTitle) return;
      commit({
        ...state,
        todos: state.todos.map(todo => todo.id === id ? { ...todo, title: cleanTitle } : todo),
      });
    },
    toggleTodo(id: string) {
      requireTodo(id);
      commit({
        ...state,
        todos: state.todos.map(todo => todo.id === id ? { ...todo, done: !todo.done } : todo),
      });
    },
    deleteTodo(id: string) {
      requireTodo(id);
      commit({ ...state, todos: state.todos.filter(todo => todo.id !== id) });
    },
    addCategory(name: string) {
      const cleanName = requiredText(name, '分类名称');
      commit({
        ...state,
        categories: [...state.categories, { id: newId(), name: cleanName }],
      });
    },
    renameCategory(id: string, name: string) {
      const cleanName = requiredText(name, '分类名称');
      const current = requireCategory(id);
      if (current.name === cleanName) return;
      commit({
        ...state,
        categories: state.categories.map(category =>
          category.id === id ? { ...category, name: cleanName } : category),
      });
    },
    deleteCategory(id: string) {
      if (id === 'inbox') throw new Error('不能删除收件箱');
      requireCategory(id);
      commit({
        ...state,
        categories: state.categories.filter(category => category.id !== id),
        todos: state.todos.map(todo =>
          todo.categoryId === id ? { ...todo, categoryId: 'inbox' } : todo),
      });
    },
    moveTodo(id: string, categoryId: string, beforeTodoId: string | null) {
      if (id === beforeTodoId) return;
      const moving = requireTodo(id);
      requireCategory(categoryId);
      if (beforeTodoId !== null) {
        const before = requireTodo(beforeTodoId);
        if (before.categoryId !== categoryId) {
          throw new Error('参照待办不属于目标分类');
        }
      }

      const todos = state.todos.filter(todo => todo.id !== id);
      let insertAt: number;
      if (beforeTodoId !== null) {
        insertAt = todos.findIndex(todo => todo.id === beforeTodoId);
      } else {
        insertAt = todos.length;
        for (let index = todos.length - 1; index >= 0; index--) {
          if (todos[index]!.categoryId === categoryId) {
            insertAt = index + 1;
            break;
          }
        }
      }
      todos.splice(insertAt, 0, { ...moving, categoryId });
      if (todos.every((todo, index) =>
        todo.id === state.todos[index]?.id &&
        todo.categoryId === state.todos[index]?.categoryId)) return;
      commit({ ...state, todos });
    },
  };
}
