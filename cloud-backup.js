(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.DajinCloudBackup=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
// Leave 16KiB for the existing JSON recovery envelope.
const MAX_FILE_BYTES=16*1024*1024,MAX_BYTES=MAX_FILE_BYTES-16384;
class Manager{
 constructor(o){Object.assign(this,o);this.state={status:'not-connected'};this.timer=null;this.running=null;this.again=false;this.generation=0;this.failures=0;}
 emit(status){this.state.status=status;try{this.onChange?.(this.state)}catch(e){}}
 schedule(){clearTimeout(this.timer);this.emit(this.transport?'pending':'not-connected');this.timer=setTimeout(()=>this.run(),this.delay??1500);this.timer?.unref?.();}
 connect(transport){this.generation++;this.transport=transport;this.state={status:'pending'};this.schedule()}
 disconnect(){this.generation++;this.transport=null;clearTimeout(this.timer);this.state={status:'not-connected'};this.emit('not-connected')}
 run(){if(this.running){this.again=true;return this.running}this.running=this.attempt().finally(()=>{this.running=null;if(this.again){this.again=false;this.schedule()}});return this.running}
 async attempt(){const transport=this.transport,generation=this.generation;let stage='capture';if(!transport){this.emit('not-connected');return false}try{
  this.emit('pending');if(this.online&&!this.online())throw Error('offline');
  const snapshot=await this.capture(),bytes=new TextEncoder().encode(snapshot.text).length;
  if(bytes>MAX_BYTES)throw Error('payload-too-large');
  const checksum=await this.hash(snapshot.text),key=checksum.slice(7);
  stage='metadata-read';let meta=await transport.find(key);
  if(!meta){stage='reserve';if(transport.reserve)await transport.reserve(checksum,bytes);stage='upload';await transport.upload(key,snapshot.text);stage='metadata-confirm';meta=await transport.confirm({checksum,payload_size:bytes,local_revision:snapshot.revision,schema_version:snapshot.schemaVersion||1,app_version:'automatic-cloud-backup-v1',object_path:transport.path(key)});}
  stage='private-download';const recovered=await transport.fetch(meta);stage='checksum-verify';
  if(await this.hash(recovered)!==checksum||meta.checksum!==checksum||meta.payload_size!==bytes)throw Error('verification-failed');
  if(generation!==this.generation)return false;
  const current=await this.capture();this.failures=0;this.state={status:current.text===snapshot.text?'connected':'pending',lastSuccessfulAt:meta.created_at,lastVerifiedAt:new Date().toISOString(),revision:current.revision,snapshotRevision:meta.local_revision,checksum};this.emit(this.state.status);if(current.text!==snapshot.text)this.again=true;return true;
 }catch(e){if(generation===this.generation){this.state.diagnostic={stage,httpStatus:/^[1-5][0-9]{2}$/.test(String(e.status))?Number(e.status):null,code:/^[0-9A-Z]{5}$/.test(String(e.code))?String(e.code):null,...(['permission-denied','content-type','bucket-not-found','network','timeout','unclassified'].includes(e.category)?{category:e.category}:{})};this.state.reason=['payload-too-large','backup-quota-full'].includes(e.message)?e.message:'request-or-verification-failed';this.emit('failed');clearTimeout(this.timer);this.timer=setTimeout(()=>this.run(),Math.min(300000,5000*2**Math.min(this.failures++,6)));this.timer?.unref?.()}return false}}
 async download(meta){const text=await this.transport.fetch(meta);if(new TextEncoder().encode(text).length!==meta.payload_size||await this.hash(text)!==meta.checksum)throw Error('云端备份校验失败');return {text,meta}}
}
function transport(client,owner){
 const bucket='business-backups',path=key=>`${owner}/${key}.json`;
 const failure=error=>{const e=Error('cloud-request-failed');const statuses=[error?.status,error?.statusCode,error?.originalError?.status];e.status=statuses.find(value=>/^[1-5][0-9]{2}$/.test(String(value)));e.code=error?.code;const message=String(error?.message||error?.originalError?.message||'');e.category=/row.level security|permission denied|access denied/i.test(message)?'permission-denied':/mime|content.type/i.test(message)?'content-type':/bucket.*not found/i.test(message)?'bucket-not-found':/fetch|network/i.test(message)?'network':/timeout|abort/i.test(message)?'timeout':'unclassified';return e};
 const checked=r=>{if(r.error)throw failure(r.error);return r.data};
 return {path,async reserve(checksum,bytes){const r=await client.rpc('reserve_business_backup',{p_checksum:checksum,p_payload_size:bytes});if(r.error){if(String(r.error.message).includes('backup-quota-full'))throw Error('backup-quota-full');throw failure(r.error)}},async find(key){return checked(await client.from('business_backups').select('*').eq('owner_id',owner).eq('checksum','sha256:'+key).maybeSingle())},
 async upload(key,text){const r=await client.storage.from(bucket).upload(path(key),new TextEncoder().encode(text),{upsert:false,contentType:'application/json'});if(r.error){const existing=await client.storage.from(bucket).download(path(key));if(existing.error)throw failure(r.error);const blob=existing.data;if(await blob.text()!==text)throw Error('immutable-conflict')}},
 async confirm(meta){checked(await client.from('business_backups').upsert({...meta,owner_id:owner},{onConflict:'owner_id,checksum',ignoreDuplicates:true}));const row=await this.find(meta.checksum.slice(7));if(!row)throw Error('missing-ack');return row},
 async fetch(meta){if(meta.owner_id!==owner||meta.object_path!==path(meta.checksum.slice(7)))throw Error('owner-path-mismatch');return await checked(await client.storage.from(bucket).download(meta.object_path)).text()},
 async list(){return checked(await client.from('business_backups').select('*').eq('owner_id',owner).order('created_at',{ascending:false}).limit(50))}}
}
return {Manager,transport,MAX_BYTES,MAX_FILE_BYTES};
});
