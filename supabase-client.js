(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.DajinSupabase=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // No SDK/network work until a caller explicitly creates a configured client.
  function createClient(config={},sdk){
    if(!config.url||!config.anonKey)return {configured:false,client:null,reason:'missing-config'};
    try{const url=new URL(config.url);if(url.protocol!=='https:')throw Error('HTTPS required');
      if(!sdk||typeof sdk.createClient!=='function')return {configured:false,client:null,reason:'missing-sdk'};
      return {configured:true,client:sdk.createClient(config.url,config.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storage:globalThis.localStorage,storageKey:"dajinCloudAuthV1"}})};
    }catch(error){return {configured:false,client:null,reason:'invalid-config'}}
  }
  return {createClient};
});
