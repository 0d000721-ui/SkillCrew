export interface Todo {
  id: string;
  title: string;
  categoryId: string;
  done: boolean;
}

export interface Category { id: string; name: string }

export interface TodoState {
  version: 1;
  categories: Category[];
  todos: Todo[];
}

export interface TodoStore {
  getState(): TodoState;
  subscribe(listener: () => void): () => void;
  addTodo(title: string, categoryId?: string): void;
  editTodo(id: string, title: string): void;
  toggleTodo(id: string): void;
  deleteTodo(id: string): void;
  addCategory(name: string): void;
  renameCategory(id: string, name: string): void;
  deleteCategory(id: string): void;
  moveTodo(id: string, categoryId: string, beforeTodoId: string | null): void;
}

export interface AppViewProps {
  state: TodoState;
  addTodo: TodoStore['addTodo'];
  editTodo: TodoStore['editTodo'];
  toggleTodo: TodoStore['toggleTodo'];
  deleteTodo: TodoStore['deleteTodo'];
  addCategory: TodoStore['addCategory'];
  renameCategory: TodoStore['renameCategory'];
  deleteCategory: TodoStore['deleteCategory'];
  moveTodo: TodoStore['moveTodo'];
}
