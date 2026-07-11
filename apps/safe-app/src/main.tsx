import ReactDOM from 'react-dom/client';
import SafeProvider from '@safe-global/safe-apps-react-sdk';
import { App } from './App';

// SafeProvider establishes the postMessage bridge to the Safe interface (app.safe.global).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <SafeProvider loader={<p style={{ fontFamily: 'system-ui', padding: 24 }}>Waiting for Safe…</p>}>
    <App />
  </SafeProvider>,
);
