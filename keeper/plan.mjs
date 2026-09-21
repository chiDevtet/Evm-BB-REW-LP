import { Contract, ZeroAddress, parseEther } from 'ethers';
import { num, required } from './common.mjs';
const quoterABI = [
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)',
];
export function sqrt(n) {
  if (n < 0n) throw Error('negative');
  if (n < 2n) return n;
  let x = n,
    y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
export async function plan(ctx) {
  const { engine, provider } = ctx;
  const token = await engine.token();
  if (token === ZeroAddress) throw Error('Bind engine first');
  const available = await engine.availableETH();
  const cap = parseEther(process.env.MAX_PROCESS_ETH || '0.01');
  const minimum = parseEther(process.env.MIN_PROCESS_ETH || '0.001');
  if (cap <= 0n || minimum <= 0n || minimum > cap) throw Error('Invalid processing limits');
  const amount = available < cap ? available : cap;
  if (amount < minimum) return null;
  const slip = BigInt(num('SLIPPAGE_BPS', 100, 1, 500));
  const lower = (n) => (n * (10000n - slip)) / 10000n;
  const burn = (amount * (await engine.burnBps())) / 10000n,
    liquidity = (amount * (await engine.liquidityBps())) / 10000n,
    buy = burn + liquidity / 2n;
  const quote = new Contract(required('V4_QUOTER_ADDRESS'), quoterABI, provider);
  const key = [ZeroAddress, token, 0, 60, await engine.hook()];
  const getQuote = async (n) =>
    (await quote.quoteExactInputSingle.staticCall([key, true, n, '0x']))[0];
  let expected = 0n;
  if (buy > 0n) {
    expected = await getQuote(buy);
    if (expected === 0n) throw Error('Empty quote');
    const probe = buy / 10n;
    if (probe === 0n) throw Error('Trade too small');
    const small = await getQuote(probe);
    if (
      expected * probe * 10000n <
      small * buy * BigInt(10000 - num('MAX_PRICE_DEVIATION_BPS', 300, 1, 1000))
    )
      throw Error('Excessive V4 price impact');
  }
  let minToken = 0n,
    minETH = 0n,
    minLP = 0n;
  if (liquidity > 0n) {
    const burnTokens = (expected * burn) / buy;
    const dust = await new Contract(
      token,
      ['function balanceOf(address) view returns(uint256)'],
      provider,
    ).balanceOf(engine.target);
    const desired = expected - burnTokens + dust;
    const eth = liquidity - liquidity / 2n;
    const v2 = new Contract(
      await engine.v2(),
      ['function factory() view returns(address)', 'function WETH() view returns(address)'],
      provider,
    );
    const factory = new Contract(
      await v2.factory(),
      ['function getPair(address,address) view returns(address)'],
      provider,
    );
    const pair = await factory.getPair(token, await v2.WETH());
    let usedTokens = desired,
      usedETH = eth,
      lp;
    if (pair !== ZeroAddress) {
      const p = new Contract(
        pair,
        [
          'function getReserves() view returns(uint112,uint112,uint32)',
          'function token0() view returns(address)',
          'function totalSupply() view returns(uint256)',
        ],
        provider,
      );
      const [a, b] = await p.getReserves();
      const tokenFirst = (await p.token0()).toLowerCase() === token.toLowerCase();
      const rt = tokenFirst ? a : b,
        re = tokenFirst ? b : a;
      const supply = await p.totalSupply();
      if (rt > 0n && re > 0n) {
        const poolRatio = rt * eth;
        const desiredRatio = desired * re;
        const diff = poolRatio > desiredRatio ? poolRatio - desiredRatio : desiredRatio - poolRatio;
        if (diff * 10000n > desiredRatio * BigInt(num('MAX_PRICE_DEVIATION_BPS', 300, 1, 1000)))
          throw Error('V2/V4 price divergence: refusing LP deposit');
        const optimalETH = (desired * re) / rt;
        if (optimalETH <= eth) usedETH = optimalETH;
        else usedTokens = (eth * rt) / re;
        lp =
          (usedTokens * supply) / rt < (usedETH * supply) / re
            ? (usedTokens * supply) / rt
            : (usedETH * supply) / re;
      } else if (supply !== 0n) throw Error('Invalid pair reserves');
    }
    lp ??= sqrt(usedTokens * usedETH) - 1000n;
    minToken = lower(usedTokens);
    minETH = lower(usedETH);
    minLP = lower(lp);
    if (minToken <= 0n || minETH <= 0n || minLP <= 0n) throw Error('LP deposit too small');
  }
  const head = await provider.getBlock('latest');
  const snapshot = head.number - num('CONFIRMATIONS', 20, 1, 100);
  const deadline = head.timestamp + 120;
  return {
    args: [amount, buy > 0n ? lower(expected) : 0n, minToken, minETH, minLP, deadline, snapshot],
    amount,
    snapshot,
    token,
  };
}
