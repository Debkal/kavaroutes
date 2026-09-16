import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {DRIVER_MIGRATIONS} from "../../../packages/driver-core/src/migrations";
import {createCloudSignatureStore} from "../src/cloud-signature-store";
import {cloudSignatureDigestInput} from "../src/cloud-signature";
test("signature draft and original command survive database reopen, duplicate taps and unknown outcome; terminal binding is immutable",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"kr-signature-"));let db=new DatabaseSync(join(dir,"test.sqlite")),tail=Promise.resolve(),counter=0;
  const adapter:any={getFirstAsync:async(sql:string,...p:any[])=>db.prepare(sql).get(...p)??null,getAllAsync:async(sql:string,...p:any[])=>db.prepare(sql).all(...p),runAsync:async(sql:string,...p:any[])=>db.prepare(sql).run(...p),
    withExclusiveTransactionAsync:(fn:any)=>{const call=tail.then(async()=>{db.exec("BEGIN");try{await fn(adapter);db.exec("COMMIT");}catch(e){db.exec("ROLLBACK");throw e;}});tail=call.catch(()=>undefined);return call;}};
  const create=()=>createCloudSignatureStore(adapter,()=>`key-${++counter}`);
  try{
    for(const m of DRIVER_MIGRATIONS)db.exec(m.sql);let store=create();
    const draft:any={points:[[1,2],[3,4]],role:"RIDER",unableReason:"PHYSICALLY_UNABLE",witness:"",policyDigest:"a".repeat(64)};
    await store.saveDraft("shift","leg","PICKUP_ATTESTATION",draft);
    const unsigned:any={shiftGeneration:"generation",evidenceId:"evidence-1",expectedTag:'"tag"',event:"PICKUP_ATTESTATION",attestationPolicyVersion:"attestation-synthetic-v2",policyVersion:1,policyDigest:"a".repeat(64),capturedAt:"2026-09-14T12:00:00Z",localActionAt:"2026-09-14T12:00:00Z",installationGeneration:"inst_synthetic0000001",parkedAttestation:true,role:"RIDER",points:draft.points};
    const request={...unsigned,digest:createHash("sha256").update(`SIGNATURE:${cloudSignatureDigestInput("shift","leg",unsigned)}`).digest("hex")};
    const first=await store.prepare("shift","leg",request);
    expect(await store.prepare("shift","leg",{...request,evidenceId:"duplicate-tap"})).toEqual(first);
    await expect(store.prepare("shift","other",request)).rejects.toThrow("PRECEDING_SIGNATURE");
    db.close();db=new DatabaseSync(join(dir,"test.sqlite"));store=create();
    expect(await store.draft("shift","leg","PICKUP_ATTESTATION")).toEqual(draft);expect((await store.commands("shift"))[0]).toEqual(first);
    const receipt:any={evidenceId:request.evidenceId,shiftReference:"shift",tripLegId:"leg",event:request.event,status:"ACCEPTED_FOR_SERVICE_CONTROL",resourceVersion:5,digest:request.digest};
    await expect(store.record(first,{...receipt,tripLegId:"other"})).rejects.toThrow("IDENTITY_CHANGED");
    await store.record(first,receipt);await store.record(first,receipt);await expect(store.record(first,null,"REJECTED")).rejects.toThrow("TERMINAL_RECEIPT_CHANGED");
    const replacement=await store.prepare("shift","leg",{...request,evidenceId:"replacement",supersedesEvidenceId:request.evidenceId});
    await store.record(replacement,null,"PRECONDITION_FAILED");db.close();db=new DatabaseSync(join(dir,"test.sqlite"));store=create();
    expect((await store.commands("shift")).map(c=>c.state)).toEqual(["ACCEPTED","REJECTED"]);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
