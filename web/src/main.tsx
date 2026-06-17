import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { APP_VERSION, BUILD_TIME } from './version';

console.info(`stormdeck ${APP_VERSION} · built ${BUILD_TIME}`);

createRoot(document.getElementById('root')!).render(<App />);
