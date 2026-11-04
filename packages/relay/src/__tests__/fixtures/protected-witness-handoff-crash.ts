/** Actual process death after a pre-funded protected handoff intent. No token authorization. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openProtectedAdmissionSpendHistory } from '../../protected-admission-history.js';
process.once('message',async(input:any)=>{
  try {
    const history=await openProtectedAdmissionSpendHistory({...input.options,encryptionKey:Buffer.from(input.encryptionKey,'hex'),now:()=>input.time,
      protection:{...input.protection,signingKey:{publicKey:Buffer.from(input.owner.publicKey,'hex'),secretKey:Buffer.from(input.owner.secretKey,'hex')}}});
    await history.ready();
    const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{rename(from,to);if(String(to).endsWith('admission-spends-v2.jsonl'))process.kill(process.pid,'SIGKILL');};
    syncBuiltinESMExports();
    await history.writeHandoffState(input.handoff);
    throw new Error('Handoff intent crash boundary was not reached');
  } catch(error) { process.send?.({error:error instanceof Error?error.message:'Handoff crash fixture failed'});process.exitCode=1;process.disconnect?.(); }
});
process.send?.('ready');
