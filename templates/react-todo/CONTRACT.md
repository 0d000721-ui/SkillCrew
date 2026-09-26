# Frozen handoff contract

The executor hashes this file, `src/contracts/index.ts`, the template baseline, and the acceptance set before launching workers.

- Gemini owns `src/ui/**` and `src/styles/**`. It exports `AppView(props: AppViewProps)` from `src/ui/AppView.tsx`. It cannot change `App.tsx`, types, dependencies, or tests.
- Codex owns `src/core/**`. It exports `createTodoStore(storage: Storage): TodoStore` from `src/core/store.ts` and `useTodoApp(): AppViewProps` from `src/core/useTodoApp.ts`.
- `moveTodo(id, categoryId, beforeTodoId)` removes the item from its current position, changes category, then inserts it immediately before `beforeTodoId`. `null` appends to the target category. An empty category accepts `null`. Moving before itself is a no-op. The new order persists after refresh.
- Deleting a category moves its todos to `inbox` without losing them. `inbox` cannot be removed. Empty titles and category names are rejected. Corrupt saved JSON starts from a valid empty state. Storage failures must be reported without pretending a write succeeded.
- The UI provides these stable selectors for independent browser tests: `todo-input`, `todo-submit`, `category-input`, `category-submit`, `todo-row`, `toggle-todo`, and `category-column`. Each category column has a heading whose accessible name is exactly the category name, so tests and assistive technology can distinguish it from menu options. It must support pointer drag and a keyboard-accessible reorder control.
- The runner executes the frozen tests. Workers may add development tests within their own paths but cannot alter `tests/**`.
