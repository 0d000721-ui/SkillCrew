import { useState } from 'react';
import type { AppViewProps, Todo } from '../contracts';

let activeDraggedId: string | null = null;

export function AppView(props: AppViewProps) {
  const {
    state,
    addTodo,
    editTodo,
    toggleTodo,
    deleteTodo,
    addCategory,
    renameCategory,
    deleteCategory,
    moveTodo,
  } = props;

  const [todoTitle, setTodoTitle] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editTodoTitle, setEditTodoTitle] = useState('');

  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');

  const [draggingId, setDraggingId] = useState<string | null>(null);

  const categories = state?.categories ?? [];
  const todos = state?.todos ?? [];

  const handleAddTodo = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = todoTitle.trim();
    if (!trimmed) return;
    try {
      addTodo(trimmed);
      setTodoTitle('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加任务失败');
    }
  };

  const handleAddCategory = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = categoryName.trim();
    if (!trimmed) return;
    try {
      addCategory(trimmed);
      setCategoryName('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加分类失败');
    }
  };

  const handleToggleTodo = (id: string) => {
    try {
      toggleTodo(id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新待办状态失败');
    }
  };

  const handleDeleteTodo = (id: string) => {
    try {
      deleteTodo(id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除任务失败');
    }
  };

  const handleStartEditTodo = (todo: Todo) => {
    setEditingTodoId(todo.id);
    setEditTodoTitle(todo.title);
  };

  const handleSaveEditTodo = (e: React.FormEvent, id: string) => {
    e.preventDefault();
    const trimmed = editTodoTitle.trim();
    if (!trimmed) return;
    try {
      editTodo(id, trimmed);
      setEditingTodoId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '编辑任务失败');
    }
  };

  const handleStartRenameCategory = (id: string, name: string) => {
    setEditingCategoryId(id);
    setEditCategoryName(name);
  };

  const handleSaveRenameCategory = (e: React.FormEvent, id: string) => {
    e.preventDefault();
    const trimmed = editCategoryName.trim();
    if (!trimmed) return;
    try {
      renameCategory(id, trimmed);
      setEditingCategoryId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名分类失败');
    }
  };

  const handleDeleteCategory = (id: string) => {
    try {
      deleteCategory(id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除分类失败');
    }
  };

  const handleMoveUp = (
    todoId: string,
    categoryId: string,
    index: number,
    categoryTodos: Todo[]
  ) => {
    if (index <= 0) return;
    const beforeTodoId = categoryTodos[index - 1].id;
    try {
      moveTodo(todoId, categoryId, beforeTodoId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '移动任务失败');
    }
  };

  const handleMoveDown = (
    todoId: string,
    categoryId: string,
    index: number,
    categoryTodos: Todo[]
  ) => {
    if (index >= categoryTodos.length - 1) return;
    const beforeTodoId = index + 2 < categoryTodos.length ? categoryTodos[index + 2].id : null;
    try {
      moveTodo(todoId, categoryId, beforeTodoId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '移动任务失败');
    }
  };

  const handleMoveToCategory = (todoId: string, targetCategoryId: string) => {
    try {
      moveTodo(todoId, targetCategoryId, null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '移动分类失败');
    }
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    activeDraggedId = id;
    setDraggingId(id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    activeDraggedId = null;
    setDraggingId(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDropOnTodo = (
    e: React.DragEvent,
    targetTodoId: string,
    targetCategoryId: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceId = e.dataTransfer.getData('text/plain') || draggingId || activeDraggedId;
    activeDraggedId = null;
    setDraggingId(null);
    if (!sourceId || sourceId === targetTodoId) return;
    try {
      moveTodo(sourceId, targetCategoryId, targetTodoId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '移动任务失败');
    }
  };

  const handleDropOnColumn = (e: React.DragEvent, targetCategoryId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData('text/plain') || draggingId || activeDraggedId;
    activeDraggedId = null;
    setDraggingId(null);
    if (!sourceId) return;
    try {
      moveTodo(sourceId, targetCategoryId, null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '移动任务失败');
    }
  };

  return (
    <div className="todo-app">
      <header className="app-header">
        <h1 className="app-title">待办事项</h1>
      </header>

      {error && (
        <div role="alert" className="error-banner">
          <span className="error-message">{error}</span>
          <button
            type="button"
            className="error-dismiss"
            onClick={() => setError(null)}
            aria-label="关闭错误提示"
          >
            ×
          </button>
        </div>
      )}

      <section className="forms-section">
        <form onSubmit={handleAddTodo} className="action-form">
          <input
            type="text"
            data-testid="todo-input"
            className="form-input"
            placeholder="新建待办事项..."
            value={todoTitle}
            onChange={(e) => setTodoTitle(e.target.value)}
          />
          <button
            type="submit"
            data-testid="todo-submit"
            className="btn btn-primary"
            disabled={!todoTitle.trim()}
          >
            添加待办
          </button>
        </form>

        <form onSubmit={handleAddCategory} className="action-form">
          <input
            type="text"
            data-testid="category-input"
            className="form-input"
            placeholder="新建分类..."
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
          />
          <button
            type="submit"
            data-testid="category-submit"
            className="btn btn-secondary"
            disabled={!categoryName.trim()}
          >
            新建分类
          </button>
        </form>
      </section>

      <main className="board-container">
        {categories.map((category) => {
          const categoryTodos = todos.filter((t) => t.categoryId === category.id);
          const isInbox = category.id === 'inbox';

          return (
            <div
              key={category.id}
              data-testid="category-column"
              className="category-column"
              onDragOver={handleDragOver}
              onDrop={(e) => handleDropOnColumn(e, category.id)}
            >
              <div className="category-header">
                <h2 className="category-title">{category.name}</h2>
                <div className="category-meta">
                  <span className="category-count">{categoryTodos.length}</span>
                  {!isInbox && (
                    <div className="category-actions">
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => handleStartRenameCategory(category.id, category.name)}
                        aria-label={`重命名分类 ${category.name}`}
                        title="重命名分类"
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        className="btn-icon text-danger"
                        onClick={() => handleDeleteCategory(category.id)}
                        aria-label={`删除分类 ${category.name}`}
                        title="删除分类"
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {editingCategoryId === category.id && (
                <form
                  onSubmit={(e) => handleSaveRenameCategory(e, category.id)}
                  className="rename-category-form"
                >
                  <input
                    type="text"
                    className="form-input rename-input"
                    value={editCategoryName}
                    onChange={(e) => setEditCategoryName(e.target.value)}
                    placeholder="分类名称"
                    autoFocus
                  />
                  <div className="form-buttons">
                    <button
                      type="submit"
                      className="btn btn-sm btn-primary"
                      disabled={!editCategoryName.trim()}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditingCategoryId(null)}
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}

              <div className="todos-list">
                {categoryTodos.length === 0 ? (
                  <div className="empty-placeholder">暂无任务，可拖拽至此</div>
                ) : (
                  categoryTodos.map((todo, index) => {
                    const isDragging = draggingId === todo.id;
                    const isEditing = editingTodoId === todo.id;

                    return (
                      <div
                        key={todo.id}
                        data-testid="todo-row"
                        className={`todo-row ${todo.done ? 'todo-done' : ''} ${
                          isDragging ? 'todo-dragging' : ''
                        }`}
                        draggable={!isEditing}
                        onDragStart={(e) => handleDragStart(e, todo.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDropOnTodo(e, todo.id, category.id)}
                      >
                        {isEditing ? (
                          <form
                            onSubmit={(e) => handleSaveEditTodo(e, todo.id)}
                            className="edit-todo-form"
                          >
                            <input
                              type="text"
                              className="form-input edit-todo-input"
                              value={editTodoTitle}
                              onChange={(e) => setEditTodoTitle(e.target.value)}
                              autoFocus
                            />
                            <div className="form-buttons">
                              <button
                                type="submit"
                                className="btn btn-sm btn-primary"
                                disabled={!editTodoTitle.trim()}
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => setEditingTodoId(null)}
                              >
                                取消
                              </button>
                            </div>
                          </form>
                        ) : (
                          <>
                            <div className="todo-main">
                              <input
                                type="checkbox"
                                data-testid="toggle-todo"
                                className="todo-checkbox"
                                checked={todo.done}
                                onChange={() => handleToggleTodo(todo.id)}
                                aria-label={`标记 "${todo.title}" 为${
                                  todo.done ? '未完成' : '已完成'
                                }`}
                              />
                              <span className="todo-title">{todo.title}</span>
                            </div>

                            <div className="todo-controls">
                              <div className="reorder-group">
                                <button
                                  type="button"
                                  className="btn-icon reorder-btn"
                                  disabled={index === 0}
                                  onClick={() =>
                                    handleMoveUp(todo.id, category.id, index, categoryTodos)
                                  }
                                  aria-label={`将待办 "${todo.title}" 上移`}
                                  title="上移"
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="btn-icon reorder-btn"
                                  disabled={index === categoryTodos.length - 1}
                                  onClick={() =>
                                    handleMoveDown(todo.id, category.id, index, categoryTodos)
                                  }
                                  aria-label={`将待办 "${todo.title}" 下移`}
                                  title="下移"
                                >
                                  ↓
                                </button>
                              </div>

                              {categories.length > 1 && (
                                <select
                                  className="category-reorder-select"
                                  value={category.id}
                                  onChange={(e) => handleMoveToCategory(todo.id, e.target.value)}
                                  aria-label={`将待办 "${todo.title}" 移动到分类`}
                                >
                                  {categories.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}
                                    </option>
                                  ))}
                                </select>
                              )}

                              <div className="todo-actions">
                                <button
                                  type="button"
                                  className="btn-icon"
                                  onClick={() => handleStartEditTodo(todo)}
                                  aria-label={`编辑待办 "${todo.title}"`}
                                  title="编辑"
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="btn-icon text-danger"
                                  onClick={() => handleDeleteTodo(todo.id)}
                                  aria-label={`删除待办 "${todo.title}"`}
                                  title="删除"
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </main>
    </div>
  );
}
