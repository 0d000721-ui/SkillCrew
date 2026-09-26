import { describe, expect, it } from 'vitest';
import { createTodoStore } from '../src/core/store';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    length: 0,
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('frozen store acceptance', () => {
  it('AC-CRUD adds, edits, completes, and deletes a todo', () => {
    const store = createTodoStore(memoryStorage());
    store.addTodo('初稿');
    const id = store.getState().todos[0]!.id;
    store.editTodo(id, '定稿');
    store.toggleTodo(id);
    expect(store.getState().todos[0]).toMatchObject({ title: '定稿', done: true });
    store.deleteTodo(id);
    expect(store.getState().todos).toHaveLength(0);
  });

  it('AC-CATEGORY moves todos to Inbox when deleting a category', () => {
    const store = createTodoStore(memoryStorage());
    store.addCategory('工作');
    const categoryId = store.getState().categories[1]!.id;
    store.addTodo('开会', categoryId);
    store.deleteCategory(categoryId);
    expect(store.getState().todos[0]!.categoryId).toBe('inbox');
  });

  it('AC-DRAG moves an item before a target and into an empty category', () => {
    const store = createTodoStore(memoryStorage());
    store.addTodo('甲'); store.addTodo('乙'); store.addTodo('丙');
    const [a, b, c] = store.getState().todos;
    store.moveTodo(c!.id, 'inbox', a!.id);
    expect(store.getState().todos.map(todo => todo.title)).toEqual(['丙', '甲', '乙']);
    store.addCategory('空分类');
    const target = store.getState().categories[1]!.id;
    store.moveTodo(b!.id, target, null);
    expect(store.getState().todos.find(todo => todo.id === b!.id)?.categoryId).toBe(target);
  });

  it('AC-PERSIST retains changes across store instances', () => {
    const storage = memoryStorage();
    createTodoStore(storage).addTodo('保存我');
    expect(createTodoStore(storage).getState().todos[0]!.title).toBe('保存我');
  });

  it('AC-RECOVER survives malformed localStorage data', () => {
    const storage = memoryStorage();
    storage.setItem('skillcrew.todos.v1', '{broken');
    expect(createTodoStore(storage).getState().todos).toEqual([]);
  });

  it('AC-RECOVER does not commit an in-memory change after storage write failure', () => {
    const storage = memoryStorage();
    const store = createTodoStore(storage);
    storage.setItem = () => { throw new Error('quota exceeded'); };
    expect(() => store.addTodo('不能保存')).toThrow();
    expect(store.getState().todos).toEqual([]);
  });
});
