import { ReactNode, useState } from 'react'

import { useDarkModeManager } from 'legacy/state/user/hooks'

import { AssetSwap } from './AssetSwap'

export function AssetSwapPreview(): ReactNode {
  const [darkMode, toggleDarkMode] = useDarkModeManager()
  const [assets, setAssets] = useState('Crypto')
  const [bounce, setBounce] = useState(30)
  const [corner, setCorner] = useState(28)
  return (
    <main className="swp-lab">
      <header>
        <p className="swp-lab-eyebrow">Local design study</p>
        <h1>A little more fluid.</h1>
        <p>Two assets. One direction. A picker that grows from the asset you choose.</p>
        <a href="#/swap">Try it in the Ophis swap box →</a>
      </header>
      <section className="swp-lab-workbench" aria-label="Asset swap preview">
        <div className="swp-lab-example">
          <AssetSwap assets={assets} bounce={bounce} corner={corner} />
          <p>Reference demo · fixed sample prices and a sample 0.3% fee.</p>
        </div>
        <div className="swp-lab-controls">
          <button type="button" className="swp-lab-theme" onClick={toggleDarkMode} aria-pressed={darkMode}>
            Dark theme
          </button>
          <label>
            Assets
            <select aria-label="Assets" value={assets} onChange={(e) => setAssets(e.target.value)}>
              <option>Crypto</option>
              <option>Currency</option>
            </select>
          </label>
          <label>
            Arrow bounce <output>{bounce}%</output>
            <input
              aria-label="Arrow bounce"
              type="range"
              min="0"
              max="100"
              value={bounce}
              onChange={(e) => setBounce(Number(e.target.value))}
            />
          </label>
          <label>
            Corner radius <output>{corner}px</output>
            <input
              aria-label="Corner radius"
              type="range"
              min="0"
              max="40"
              value={corner}
              onChange={(e) => setCorner(Number(e.target.value))}
            />
          </label>
          <p>Compare both themes. Escape closes the picker and returns focus to the asset.</p>
        </div>
      </section>
      <p className="swp-lab-credit">
        Adapted from <a href="https://bencho.dev/licence">Bencho, by Lorenzo Cabra</a> · MIT.
      </p>
    </main>
  )
}
