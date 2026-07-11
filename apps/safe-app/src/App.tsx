import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk';
import { SwapForm } from './components/SwapForm';
import { isOphisFeeChain } from './lib/chains';

const shell = { fontFamily: 'system-ui', padding: 24, maxWidth: 520 } as const;

export function App() {
  const { sdk, safe, connected } = useSafeAppsSDK();

  if (!connected) {
    return (
      <main style={shell}>
        <h1>Ophis Swap</h1>
        <p>Open this app inside a Safe (app.safe.global). It needs the Safe context to build orders.</p>
      </main>
    );
  }

  if (!isOphisFeeChain(safe.chainId)) {
    return (
      <main style={shell}>
        <h1>Ophis Swap</h1>
        <p>Chain {safe.chainId} is not supported by Ophis yet. Switch your Safe to a supported chain.</p>
      </main>
    );
  }

  return <SwapForm sdk={sdk} owner={safe.safeAddress} chainId={safe.chainId} />;
}
