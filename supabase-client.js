(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.DajinSupabase=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // No SDK/network work until a caller explicitly creates a configured client.
  const AUTH_TIMEOUT_MS=15000;
  // Bound only password login, leaving backup transport and refresh semantics unchanged.
  function authFetch(fetcher=globalThis.fetch,timeout=AUTH_TIMEOUT_MS){
    return async function(input,options={}){
      const url=new URL(typeof input==='string'?input:input.url);
      if(!url.pathname.endsWith('/auth/v1/token')||url.searchParams.get('grant_type')!=='password')return fetcher(input,options);
      const controller=new AbortController();let expired=false;
      const abort=()=>controller.abort(options.signal?.reason);
      if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(()=>{expired=true;controller.abort()},timeout);
      try{
        const response=await fetcher(input,{...options,signal:controller.signal});
        // Auth reads a small JSON response. Include the body in the deadline.
        const body=await response.arrayBuffer();
        return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      }catch(error){if(expired)throw Error('cloud-auth-timeout');throw error}
      finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort)}
    };
  }
  function loginError(error){
    if(error?.message==='cloud-auth-timeout')return '连接超时，请检查网络后重新输入密码重试。';
    if(error?.code==='invalid_credentials')return '邮箱或密码不正确，请核对后重试。';
    if(error?.code==='email_not_confirmed')return '邮箱尚未验证，请先完成邮箱验证。';
    if(error?.status===429||['over_request_rate_limit','over_email_send_rate_limit'].includes(error?.code))return '登录请求过于频繁，请稍后重试。';
    if(error?.status>=500)return '云端认证服务暂时不可用，请稍后重试。';
    if(error?.name==='AuthRetryableFetchError'||error?.name==='TypeError'||error?.name==='AbortError')return '网络连接失败，请检查网络后重试。';
    return '登录未完成，请稍后重试；如持续失败，请联系维护人员。';
  }
  function createClient(config={},sdk){
    if(!config.url||!config.anonKey)return {configured:false,client:null,reason:'missing-config'};
    try{const url=new URL(config.url);if(url.protocol!=='https:')throw Error('HTTPS required');
      if(!sdk||typeof sdk.createClient!=='function')return {configured:false,client:null,reason:'missing-sdk'};
      return {configured:true,client:sdk.createClient(config.url,config.anonKey,{global:{fetch:authFetch()},auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storage:globalThis.localStorage,storageKey:"dajinCloudAuthV1"}})};
    }catch(error){return {configured:false,client:null,reason:'invalid-config'}}
  }
  return {createClient,authFetch,loginError,AUTH_TIMEOUT_MS};
});
