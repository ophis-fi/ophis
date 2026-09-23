function getStory(): HTMLElement {
  const root = document.querySelector<HTMLElement>('#swap-story');
  if (!root) throw new Error('Missing swap-story component');
  return root;
}
const root = getStory();
type Visual = HTMLElement | SVGElement;
type Point = [number, number];
type Curve = [Point, Point, Point, Point];
const get = (id: string): Visual => {
  const node = root.querySelector<Visual>(`#${id}`);
  if (!node) throw new Error(`Missing swap-story node: ${id}`);
  return node;
};
const svg = get('playground'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
const tokens = {USDC: '/logos/swap-story/usdc.svg', ETH: '/logos/swap-story/ethereum.svg', SOL: '/logos/swap-story/solana.svg', AAPLc: '/logos/swap-story/AAPLc.png', NVDAc: '/logos/swap-story/NVDAc.png'};
const chains = {Ethereum: '/logos/swap-story/ethereum.svg', Solana: '/logos/swap-story/solana.svg', Base: '/logos/swap-story/base.png'};
// Stock examples use Ophis's canonical Coinbase token list on Base.
const examples: [keyof typeof tokens, keyof typeof tokens, keyof typeof venueSets, keyof typeof chains, string][] = [
  ['USDC', 'SOL', 'Ethereum', 'Solana', 'Crosschain'],
  ['ETH', 'USDC', 'Ethereum', 'Ethereum', 'Same-chain swap'],
  ['USDC', 'AAPLc', 'Base', 'Base', 'Tokenized stocks'],
  ['USDC', 'ETH', 'Base', 'Ethereum', 'Crosschain'],
  ['USDC', 'NVDAc', 'Base', 'Base', 'Tokenized stocks'],
];
const changing = ['source-logo', 'destination-logo', 'source-chain-logo', 'destination-chain-logo', 'intent-label', 'venue-logo-1', 'venue-name-1'].map(get);
changing.filter(node => node.namespaceURI !== 'http://www.w3.org/2000/svg').forEach(node => { const host = document.createElement('span'); host.style.display = 'inline-grid'; node.before(host); host.append(node); });

const solverNames = ['Horadrim', 'Tsolver', 'OKX'];
const venueSets = {
  Ethereum: [['Uniswap', '/logos/swap-story/uniswap.svg'], ['Curve', '/logos/swap-story/curve.png'], ['SushiSwap', '/logos/swap-story/sushi.svg']],
  Base: [['Uniswap', '/logos/swap-story/uniswap.svg'], ['Aerodrome', '/logos/swap-story/aerodrome.png'], ['SushiSwap', '/logos/swap-story/sushi.svg']],
};
const venueNodes = [0, 1, 2].map(i => ({card: get(`venue-${i}`), path: get(`venue-path-${i}`), active: get(`venue-active-${i}`), quote: get(`quote-${i}`)}));

// Preload the next routes so an asset change cannot flash a missing logo.
[...new Set([...Object.values(tokens), ...Object.values(chains)])].forEach(src => { const img = new Image(); img.src = src; });
const incoming = [get('path-in'), get('trail-in')], outgoing = [get('path-out'), get('trail-out')];
const order = get('order-packet'), delivery = get('delivery-packet');
const sourceCheck = get('source-check'), receipt = get('receipt'), burst = get('burst');
const coin = get('destination-coin');
const solvers = [0, 1, 2].map(i => ({row: get(`solver-${i}`), bid: get(`bid-${i}`), check: get(`solver-check-${i}`), order: get(`batch-order-${i}`), path: get(`solver-path-${i}`), active: get(`solver-active-${i}`), quote: get(`solver-quote-${i}`)}));
const state = {
  ghosts: [] as Visual[], venuePaths: [] as Curve[], solverPaths: [] as Curve[], sellPaths: [] as Curve[],
  liquidityEntries: [] as Point[], liquidityExits: [] as Point[], paths: [] as Curve[],
  example: 0, small: false, visible: false, frame: 0, last: null as number | null, elapsed: 0,
};
const duration = 4800;
const clamp = (x: number): number => Math.max(0, Math.min(1, x));
const ease = (x: number): number => { x = clamp(x); return x * x * (3 - 2 * x); };
const windowOpacity = (p: number, start: number, end: number, fade = .035): number => ease((p - start) / fade) * (1 - ease((p - end) / fade));
const opacity = (node: Visual, value: number): void => node.setAttribute('opacity', value.toFixed(3));
// The same Bézier geometry draws the route and positions its moving packet.
function point(curve: Curve, t: number): Point {
  const u = 1 - t;
  return [0, 1].map(axis => u*u*u*curve[0][axis] + 3*u*u*t*curve[1][axis] + 3*u*t*t*curve[2][axis] + t*t*t*curve[3][axis]) as Point;
}
function packet(node: Visual, curve: Curve, p: number, start: number, end: number): void {
  const t = clamp((p - start) / (end - start));
  const [x, y] = point(curve, ease(t));
  node.setAttribute('transform', `translate(${x} ${y}) scale(${state.small ? .8 : 1})`);
  opacity(node, windowOpacity(p, start, end - .03, .03));
}
function render(p: number): void {
  const fade = state.ghosts.length ? ease(p / .10) : 1;
  changing.forEach(node => { node.style.opacity = String(fade); });
  state.ghosts.forEach(node => { node.style.opacity = String(1 - fade); });
  if (fade === 1) { state.ghosts.forEach(node => node.remove()); state.ghosts = []; }

  const selectedVenue = [0, 2, 0, 1, 0][state.example];
  const winningSolver = [1, 2, 0, 2, 1][state.example];
  // Sell-side route exploration; the pulse represents the request, not an early funds transfer.
  state.paths[0] = state.sellPaths[selectedVenue];
  const [a,b,c,d] = state.paths[0];
  incoming.forEach(node => node.setAttribute('d', `M${a}C${b} ${c} ${d}`));
  packet(order, state.paths[0], p, .06, .28);
  // Venue liquidity and solver bids are distinct, illustrative inputs; no live quotes.
  venueNodes.forEach((venue, i) => {
    const start = .29 + i * .015, end = .44 + i * .015;
    const [x, y] = point(state.venuePaths[i], ease((p - start) / (end - start)));
    venue.quote.setAttribute('cx', String(x)); venue.quote.setAttribute('cy', String(y));
    opacity(venue.quote, windowOpacity(p, start, end - .02, .02));
    venue.card.classList.toggle('is-selected', i === selectedVenue && p >= .57 && p < .94);
    opacity(venue.active, i === selectedVenue ? windowOpacity(p, .57, .91) : 0);
    opacity(get(`sell-active-${i}`), i === selectedVenue ? windowOpacity(p, .57, .91) : 0);
    opacity(get(`liquidity-active-${i}`), i === winningSolver ? windowOpacity(p, .57, .91) : 0);
  });
  solvers.forEach((solver, i) => {
    const gather = ease((p - .12 - i * .04) / .15);
    const angle = (55 + i * 35) * Math.PI / 180;
    const radius = 120 - 43 * gather;
    solver.order.setAttribute('transform', `translate(${Math.cos(angle) * radius} ${Math.sin(angle) * radius}) scale(${.8 + .2 * gather})`);
    opacity(solver.order, windowOpacity(p, .10 + i * .04, .69, .07));
    const firstBid = (46 + i * 9) * ease((p - .34 - i * .015) / .11);
    const improvement = (i === winningSolver ? 100 - (46 + i * 9) : 9) * ease((p - .46) / .10);
    solver.bid.setAttribute('stroke-dashoffset', (100 - (firstBid + improvement) * (1 - ease((p - .91) / .09))).toFixed(2));
    const winner = i === winningSolver && p >= .57 && p < .95;
    solver.row.classList.toggle('is-winner', winner);
    opacity(solver.check, winner ? windowOpacity(p, .57, .91, .07) : 0);
    opacity(solver.active, i === winningSolver ? windowOpacity(p, .57, .88, .07) : 0);
    // Batch dispatch travels out; competing execution proposals return on the same link.
    if (p < .34) packet(solver.quote, [state.solverPaths[i][3], state.solverPaths[i][2], state.solverPaths[i][1], state.solverPaths[i][0]], p, .23, .33);
    else packet(solver.quote, state.solverPaths[i], p, .43 + i*.012, .56 + i*.012);
  });
  const entry = state.liquidityEntries[selectedVenue], exit = state.liquidityExits[winningSolver];
  get('bus-active').setAttribute('d', `M${entry}L${exit}`);
  opacity(get('bus-active'), windowOpacity(p, .57, .91));
  get('batch-ring').setAttribute('stroke-opacity', (.55 + .25 * Math.sin(Math.PI * p)).toFixed(3));
  opacity(get('winner-label'), windowOpacity(p, .57, .91, .06));
  packet(delivery, state.paths[1], p, .635, .81);
  opacity(sourceCheck, windowOpacity(p, .61, .94));
  get('execution-label').textContent = p < .67 || root.dataset.mode !== 'cross' ? 'Settled' : 'Crosschain delivery';
  opacity(get('execution-label'), windowOpacity(p, .61, .94));
  opacity(receipt, windowOpacity(p, .825, .945, .025));
  opacity(incoming[1], windowOpacity(p, .08, .91) * .65);
  opacity(outgoing[1], windowOpacity(p, .64, .91) * .8);
  const hop = Math.sin(Math.PI * clamp((p - .805) / .12)) * 7;
  coin.setAttribute('transform', `translate(0 ${-hop})`);
  const pop = clamp((p - .81) / .14);
  burst.setAttribute('transform', `scale(${.88 + pop * .28})`);
  opacity(burst, Math.sin(pop * Math.PI) * .8);
}
function draw(node: Visual, curve: Curve): void {
  const [a,b,c,d] = curve; node.setAttribute('d', `M${a}C${b} ${c} ${d}`);
}
function layoutVenues(source: Point, solverPositions: Point[]): void {
  const positions: Point[] = state.small ? [[64,250],[180,250],[296,250]] : [[265,160],[265,285],[265,410]];
  state.sellPaths = positions.map<Curve>(([x,y]) => state.small
    ? [source, [180,195], [x,185], [x,y]]
    : [source, [160,285], [175,y], [x,y]]);
  state.sellPaths.forEach((curve,i) => [get(`sell-path-${i}`),get(`sell-active-${i}`)].forEach(node => draw(node,curve)));
  state.liquidityEntries = positions.map<Point>(([x,y]) => state.small ? [x,318] : [375,y]);
  state.liquidityExits = solverPositions.map<Point>(([x,y]) => state.small ? [x,318] : [375,y]);
  get('liquidity-bus').setAttribute('d', `M${state.liquidityEntries[0]}L${state.liquidityEntries[2]}`);
  state.venuePaths = positions.map<Curve>(([x,y],i) => state.small
    ? [[x,y+33],[x,328],[x,345],solverPositions[i]]
    : [[x+33,y],[375,y],[410,y],solverPositions[i]]);
  venueNodes.forEach((venue,i) => {
    venue.card.setAttribute('transform', `translate(${positions[i]})`);
    const start = state.small ? [positions[i][0], positions[i][1]+33] : [positions[i][0]+33,positions[i][1]];
    const [x,y] = solverPositions[i], end = state.small ? [x,y-36] : [x-39,y];
    [venue.path,venue.active].forEach(node => node.setAttribute('d', `M${start}L${state.liquidityEntries[i]}`));
    [get(`liquidity-path-${i}`),get(`liquidity-active-${i}`)].forEach(node => node.setAttribute('d', `M${state.liquidityExits[i]}L${end}`));
  });
  get('venue-heading').setAttribute('x', String(state.small ? 180 : 265));
  get('venue-heading').setAttribute('y', String(state.small ? 198 : 96));
}
function layoutLabels(): void {
  svg.setAttribute('viewBox', state.small ? '0 80 360 790' : '0 70 1080 450');
  get('execution-label').setAttribute('x', String(state.small ? 180 : 890));
  get('execution-label').setAttribute('y', String(state.small ? 685 : 250));
  get('solver-heading').setAttribute('x', String(state.small ? 180 : 485));
  get('solver-heading').setAttribute('y', String(state.small ? 333 : 96));
}
function layout(): void {
  state.small = matchMedia('(max-width: 850px)').matches;
  const source: Point = state.small ? [180, 130] : [85, 285];
  const center: Point = state.small ? [180, 565] : [755, 285];
  const destination: Point = state.small ? [180, 760] : [995, 285];
  const solverPositions: Point[] = state.small ? [[64, 390], [180, 390], [296, 390]] : [[485, 160], [485, 285], [485, 410]];
  get('source-node').setAttribute('transform', `translate(${source}) scale(${state.small ? .64 : .7})`);
  get('portal').setAttribute('transform', `translate(${center}) scale(${state.small ? .9 : 1})`);
  get('destination-node').setAttribute('transform', `translate(${destination}) scale(${state.small ? .64 : .8})`);
  receipt.setAttribute('transform', 'translate(0 -38)');
  state.paths = state.small
    ? [[source, source, source, source], [center, [180, 635], [180, 690], destination]]
    : [[source, source, source, source], [center, [835, 285], [915, 285], destination]];
  [incoming, outgoing].forEach((nodes, i) => nodes.forEach(node => draw(node, state.paths[i])));
  state.solverPaths = solverPositions.map<Curve>(([x,y]) => state.small
    ? [[x,y], [x,475], [180,485], center]
    : [[x,y], [580,y], [645,285], center]);
  solvers.forEach((solver, i) => {
    solver.row.setAttribute('transform', `translate(${solverPositions[i]}) scale(${state.small ? .9 : 1})`);
    [solver.path, solver.active].forEach(node => draw(node, state.solverPaths[i]));
  });
  layoutLabels();
  layoutVenues(source, solverPositions);
  render(reduced.matches ? .90 : state.elapsed / duration);
}
function tick(now: number): void {
  if (state.last !== null) {
    state.elapsed += now - state.last;
    if (state.elapsed >= duration) {
      const count = Math.floor(state.elapsed / duration);
      state.elapsed %= duration;
      updateExample((state.example + count) % examples.length);
    }
  }
  state.last = now;
  render(state.elapsed / duration);
  state.frame = requestAnimationFrame(tick);
}
function sync(): void {
  cancelAnimationFrame(state.frame); state.last = null;
  const running = state.visible && !document.hidden && !reduced.matches;
  root.dataset.playing = String(running);
  if (reduced.matches) render(.90);
  if (running) state.frame = requestAnimationFrame(tick);
}
function updateExample(index: number): void {
  state.ghosts.forEach(node => node.remove()); state.ghosts = [];
  if (root.dataset.example !== undefined) changing.forEach(node => {
    const previous = node.cloneNode(true);
    if (!(previous instanceof HTMLElement || previous instanceof SVGElement)) return;
    previous.removeAttribute('id'); previous.setAttribute('aria-hidden', 'true');
    previous.style.pointerEvents = 'none';
    if (node.namespaceURI !== 'http://www.w3.org/2000/svg') {
      // HTML captions share one grid cell for a real crossfade without reflow.
      if (node.parentElement) node.parentElement.style.display = 'grid';
      node.style.gridArea = previous.style.gridArea = '1 / 1';
    }
    node.after(previous); state.ghosts.push(previous);
  });
  state.example = index;
  const [sell, buy, source, destination, kind] = examples[index];
  const cross = source !== destination;
  root.dataset.example = String(index);
  root.dataset.mode = cross ? 'cross' : 'swap';
  get('intent-label').replaceChildren(document.createTextNode(sell + ' '), Object.assign(document.createElement('span'), {className: 'intent-arrow', textContent: '→'}), document.createTextNode(' ' + buy));
  get('source-logo').setAttribute('href', tokens[sell]);
  get('order-logo').setAttribute('href', tokens[sell]);
  get('winner-label').textContent = solverNames[[1, 2, 0, 2, 1][index]] + ' wins';
  get('source-chain-logo').setAttribute('href', chains[source]);
  get('destination-chain-logo').setAttribute('href', chains[destination]);
  ['destination-logo', 'delivery-logo'].forEach(id => get(id).setAttribute('href', tokens[buy]));
  get('execution-label').textContent = cross ? 'Crosschain delivery' : 'Settlement';
  get('scene-title').textContent = `${sell} on ${source} to ${buy} on ${destination}`;
  get('scene-description').textContent = cross
    ? `An illustrative signed order travels through Ophis. Source settlement on ${source} is followed by delivery and receipt on ${destination}.`
    : `An illustrative ${kind.toLowerCase()} on ${source}. Solvers find execution within the signed limits; ${buy} is received after settlement.`;
  venueSets[source].forEach(([name, logo], i) => {
    get(`venue-name-${i}`).textContent = name;
    get(`venue-logo-${i}`).setAttribute('href', logo);
  });
  get('scene-description').textContent += ' The visual reading order is sell token, DEX liquidity venues, competing solvers, Ophis batch auction, then received token. The sell token fans out to available venue routes, which feed a shared solver liquidity network. These links show route exploration, not funds transferred before a winner is selected. The batch dispatches orders to solvers, which return execution proposals. The Ophis hub represents coordination, not custody. Signed orders collect into a batch; solvers compete with execution proposals; the winning valid bid settles before receipt. Solvers search venues including ' + venueSets[source].map(v => v[0]).join(', ') + '. Horadrim, Tsolver and OKX are named from the source-chain solver registry. Progress rings illustrate competing proposals, not live quotes. One example winner is highlighted; actual participation, venue and pair availability varies.';
}
reduced.addEventListener('change', sync);
document.addEventListener('visibilitychange', sync);
new ResizeObserver(layout).observe(root);
new IntersectionObserver(entries => { state.visible = entries.some(entry => entry.isIntersecting); sync(); }).observe(svg);
layout(); updateExample(0); sync();

export {};
