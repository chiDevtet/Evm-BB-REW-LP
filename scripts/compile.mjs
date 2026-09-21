import fs from 'node:fs';
import solc from 'solc';
fs.mkdirSync('artifacts', { recursive: true });
const sources = Object.fromEntries(
  fs
    .readdirSync('contracts')
    .filter((f) => f.endsWith('.sol'))
    .map((f) => [f, { content: fs.readFileSync(`contracts/${f}`, 'utf8') }]),
);
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'shanghai',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if (out.errors?.some((e) => e.severity === 'error')) process.exit(1);
for (const contracts of Object.values(out.contracts))
  for (const [name, c] of Object.entries(contracts)) {
    fs.writeFileSync(
      `artifacts/${name}.json`,
      JSON.stringify(
        {
          abi: c.abi,
          bytecode: '0x' + c.evm.bytecode.object,
          runtimeBytes: c.evm.deployedBytecode.object.length / 2,
        },
        null,
        2,
      ),
    );
    if (c.evm.deployedBytecode.object.length / 2 > 24576) throw Error(`${name} exceeds EIP-170`);
  }
fs.writeFileSync('artifacts/compiler-input.json', JSON.stringify(input));
console.log('Compiled with', solc.version());
