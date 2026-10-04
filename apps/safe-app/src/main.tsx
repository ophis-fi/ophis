import ReactDOM from 'react-dom/client';
import SafeProvider from '@safe-global/safe-apps-react-sdk';
import { App } from './App';
import './styles.css';

// SafeProvider establishes the postMessage bridge to the Safe interface (app.safe.global).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <SafeProvider loader={
    <main>
      <img src="/ophis-mono.svg" width="32" height="32" alt="Ophis" />
      <h1>Your Safe. Your next move.</h1>
      <p role="status">Waiting for a connection to Safe.</p>
      <p>Open your Safe, go to Apps, and add <code>https://safe.ophis.fi</code> as a custom app.</p>
      <p><a href="https://app.safe.global/" target="_blank" rel="noopener noreferrer">Open Safe</a></p>
    </main>
  }>
    <App />
  </SafeProvider>,
);
