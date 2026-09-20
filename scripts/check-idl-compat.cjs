/**
 * Verify the JS client can actually read the IDL the CLI produced.
 *
 * The two version independently: the Rust crate and anchor-cli are on 1.2.0 while the npm
 * client's latest is 0.32.1. The IDL format has been stable since 0.30, but "should be
 * fine" is not evidence, and a mismatch would surface as confusing decode failures deep in
 * the test suite rather than as an obvious version error.
 *
 *   node scripts/check-idl-compat.cjs
 */
const anchor = require('@coral-xyz/anchor');
const idl = require('../packages/sdk/idl/rung.json');

try {
  // Constructing the coder is the real test: it builds discriminators and borsh layouts
  // for every instruction, account and event in the IDL.
  const coder = new anchor.BorshCoder(idl);
  console.log('BorshCoder built OK');
  console.log('  client  :', require('@coral-xyz/anchor/package.json').version);
  console.log('  program :', idl.address);
  console.log('  instructions:', idl.instructions.length);

  // Round-trip an instruction to prove the layouts work rather than merely exist.
  const data = coder.instruction.encode('set_paused', { paused: true });
  const decoded = coder.instruction.decode(data);
  console.log(`  set_paused -> ${data.length} bytes (${data.toString('hex')})`);
  console.log(`  decodes to -> ${decoded.name} ${JSON.stringify(decoded.data)}`);

  // Account layouts are used on every fetch, so exercise one too.
  for (const a of idl.accounts) {
    const size = coder.accounts.size(a.name);
    console.log(`  account ${a.name}: ${size} bytes`);
  }

  console.log('\nCOMPATIBLE');
} catch (e) {
  console.error('\nINCOMPATIBLE:', e.message);
  process.exit(1);
}
