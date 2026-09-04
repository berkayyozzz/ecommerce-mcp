import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {pinterestOAuthRouter} from '../dist/pinterest-oauth.js';

test('OAuth session, password, state, scope validation and single-use callback', async()=>{
 const keys=['PINTEREST_CLIENT_ID','PINTEREST_CLIENT_SECRET','PINTEREST_REDIRECT_URI','MCP_CONNECTOR_SECRET'];
 const previous=keys.map(k=>process.env[k]);
 Object.assign(process.env,{PINTEREST_CLIENT_ID:'test-id',PINTEREST_CLIENT_SECRET:'test-secret',PINTEREST_REDIRECT_URI:'https://example.com/pinterest/callback',MCP_CONNECTOR_SECRET:'test-connector-password-long-enough'});
 const app=express();app.use(express.urlencoded({extended:false}));app.use('/pinterest',pinterestOAuthRouter);
 const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`; const original=globalThis.fetch;let exchanges=0;
 globalThis.fetch=async (url,opts)=>{
  if(String(url).endsWith('/v5/oauth/token')){exchanges++;return Response.json({access_token:'test-access',refresh_token:'test-refresh',scope:'boards:read pins:read pins:write user_accounts:read',expires_in:3600});}
  return original(url,opts);
 };
 try {
  const start=await fetch(base+'/pinterest/connect');assert.equal(start.status,200);assert.equal(start.headers.get('cache-control'),'no-store');
  assert.equal(start.headers.get('referrer-policy'),'same-origin');
  assert.match(start.headers.get('content-security-policy'),/form-action 'self' https:\/\/www\.pinterest\.com;/);
  const cookie=start.headers.get('set-cookie').split(';')[0];const nonce=cookie.split('=')[1];
  const input={nonce,password:process.env.MCP_CONNECTOR_SECRET};
  const nullOrigin=await fetch(base+'/pinterest/connect',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,Origin:'null'},body:new URLSearchParams(input)});assert.equal(nullOrigin.status,403);
  const bad=await fetch(base+'/pinterest/connect',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,Origin:'https://evil.example'},body:new URLSearchParams(input)});assert.equal(bad.status,403);
  const login=await fetch(base+'/pinterest/connect',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,Origin:'https://example.com'},body:new URLSearchParams(input)});
  assert.equal(login.status,303);assert.equal(new URL(login.headers.get('location')).searchParams.get('state'),nonce);
  const wrong=await fetch(base+'/pinterest/callback?state=wrong&code=test',{headers:{Cookie:cookie}});assert.equal(wrong.status,403);assert.equal(exchanges,0);
  const callback=await fetch(base+`/pinterest/callback?state=${nonce}&code=test`,{headers:{Cookie:cookie}});assert.equal(callback.status,200);assert.match(await callback.text(),/PINTEREST_ACCESS_TOKEN/);assert.equal(exchanges,1);
  assert.equal(callback.headers.get('referrer-policy'),'no-referrer');
  const replay=await fetch(base+`/pinterest/callback?state=${nonce}&code=test`,{headers:{Cookie:cookie}});assert.equal(replay.status,403);assert.equal(exchanges,1);
 } finally {globalThis.fetch=original;server.close();keys.forEach((k,i)=>previous[i]===undefined?delete process.env[k]:process.env[k]=previous[i]);}
});
