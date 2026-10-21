// Bound the real watch compiler even if its test/controller process disappears.
if(!process.env.AGF_TEST_COMPILER_NONCE)throw Error('Compiler deadline requires explicit test identity');
setTimeout(()=>process.exit(91),20000).unref();
