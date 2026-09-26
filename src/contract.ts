export const CONTRACT = {
  schemaVersion: 1,
  projectType: 'react-todo',
  templateVersion: '1.0.1',
  sharedTypes: 'src/contracts/index.ts',
  entry: 'src/App.tsx',
  uiExport: 'AppView(props: AppViewProps)',
  logicExports: ['createTodoStore(storage: Storage): TodoStore', 'useTodoApp(): AppViewProps'],
  ownership: {
    gemini: ['src/ui/**', 'src/styles/**'],
    codex: ['src/core/**'],
  },
  behavior: {
    move: 'Remove the todo, change category, insert before beforeTodoId; null appends. Empty category accepts null. Persist order.',
    deleteCategory: 'Move its todos to inbox without losing them. Inbox cannot be deleted.',
    storage: 'Restore from localStorage; malformed JSON starts empty; failed writes must not claim success.',
  },
  acceptanceIds: ['AC-CRUD', 'AC-CATEGORY', 'AC-DRAG', 'AC-PERSIST', 'AC-RECOVER'],
} as const;
