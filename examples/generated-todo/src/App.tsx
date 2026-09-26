import { AppView } from './ui/AppView';
import { useTodoApp } from './core/useTodoApp';

export function App() {
  return <AppView {...useTodoApp()} />;
}
