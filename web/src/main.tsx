import { createRoot } from 'react-dom/client';
import App from './App';
import { syncDisplayMode } from './viewport';
import { registerPwa } from './pwa';
import './style.css';
import './mobile.css';
import './workspace.css';

const root = document.getElementById('root');
if (!root) throw new Error('Heracles 页面缺少应用挂载节点。');
syncDisplayMode();
createRoot(root).render(<App />);
registerPwa();
