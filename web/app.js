const el = (id) => document.getElementById(id);
function units(raw, decimals = 18) {
  const n = BigInt(raw || 0),
    base = 10n ** BigInt(decimals);
  return `${(n / base).toLocaleString()}.${(n % base).toString().padStart(decimals, '0').slice(0, 4).padEnd(4, '0')}`;
}
async function update() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw Error('Live data unavailable');
    const d = await res.json();
    if (!d.configured) return;
    el('status').textContent = d.paused ? 'PAUSED' : 'ACTIVE';
    el('notice').textContent = d.paused
      ? 'Utility processing is paused. Existing published payouts remain available.'
      : `Live contract connected. ${d.health?.dry ? 'Keeper is in dry-run mode.' : d.health?.ok ? 'Keeper last check succeeded.' : 'Keeper status unavailable.'}`;
    el('processed').textContent = units(d.totalProcessed) + ' ETH';
    el('burned').textContent = units(d.totalBurned, d.decimals) + ' ' + d.symbol;
    el('rewards').textContent = units(d.reservedETH) + ' ETH';
    el('lp').textContent = units(d.totalLpMinted) + ' LP';
    for (const [id, key] of [
      ['burn-share', 'burnBps'],
      ['reward-share', 'rewardBps'],
      ['liquidity-share', 'liquidityBps'],
    ])
      el(id).textContent = Number(d[key]) / 100 + '%';
    el('treasury-share').textContent =
      `${Number(d.treasuryLpBps) / 100}% of new LP goes to treasury; ${100 - Number(d.treasuryLpBps) / 100}% to holders.`;
    document.querySelector('.orbit').style.background =
      `conic-gradient(var(--green) 0 ${Number(d.burnBps) / 100}%,var(--blue) 0 ${(Number(d.burnBps) + Number(d.rewardBps)) / 100}%,var(--purple) 0 100%)`;
    el('contract-link').href = 'https://robinhoodchain.blockscout.com/address/' + d.engine;
    el('contract-link').hidden = false;
    el('updated').textContent = 'Updated ' + new Date(d.updatedAt).toLocaleTimeString();
    if (d.epochs.length) {
      el('epochs').replaceChildren(
        ...d.epochs.map((e) => {
          const tr = document.createElement('tr');
          for (const v of [
            '#' + e.id,
            e.snapshotBlock,
            units(e.ethBudget),
            units(e.ethPaid),
            units(e.lpBudget),
          ]) {
            const td = document.createElement('td');
            td.textContent = v;
            tr.append(td);
          }
          const td = document.createElement('td'),
            a = document.createElement('a');
          a.href = '/api/epochs/' + e.id;
          a.textContent = e.published ? 'Published ↗' : 'Pending review ↗';
          a.target = '_blank';
          a.rel = 'noopener';
          td.append(a);
          tr.append(td);
          return tr;
        }),
      );
    }
  } catch {
    el('notice').textContent =
      'Live data is temporarily unavailable. Displayed figures may be stale.';
    el('status').textContent = 'OFFLINE';
  }
}
update();
setInterval(update, 30000);
