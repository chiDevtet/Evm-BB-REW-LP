import 'dotenv/config';
import fs from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, getAddress } from 'ethers';
const req = (k) => {
  if (!process.env[k]) throw Error(`${k} required`);
  return process.env[k];
};
const p = new JsonRpcProvider(req('RPC_URL'));
if ((await p.getNetwork()).chainId !== 4663n) throw Error('Expected Robinhood chain 4663');
const addresses = [
  'OWNER_ADDRESS',
  'KEEPER_ADDRESS',
  'TREASURY_ADDRESS',
  'HOOK_ADDRESS',
  'V4_ROUTER_ADDRESS',
  'V2_ROUTER_ADDRESS',
].map((k) => getAddress(req(k)));
for (const a of addresses.slice(3)) if ((await p.getCode(a)) === '0x') throw Error(`No code: ${a}`);
const v2 = new Contract(
  addresses[5],
  ['function factory() view returns(address)', 'function WETH() view returns(address)'],
  p,
);
if ((await v2.factory()).toLowerCase() !== req('V2_FACTORY_ADDRESS').toLowerCase())
  throw Error('V2 factory mismatch');
if ((await p.getCode(await v2.WETH())) === '0x') throw Error('WETH missing');
const artifact = JSON.parse(fs.readFileSync('artifacts/UtilityEngine.json', 'utf8'));
const args = [...addresses, req('V4_SIX_FIELD') === 'true'];
console.log('Constructor:', args, 'WETH:', await v2.WETH());
if (!process.argv.includes('--broadcast')) {
  console.log('Preflight only. Add --broadcast to deploy with your local DEPLOYER_PRIVATE_KEY.');
  process.exit(0);
}
const signer = new Wallet(req('DEPLOYER_PRIVATE_KEY'), p);
const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
const deployed = await factory.deploy(...args);
console.log('Deployment transaction', deployed.deploymentTransaction().hash);
await deployed.waitForDeployment();
console.log('Engine', await deployed.getAddress());
