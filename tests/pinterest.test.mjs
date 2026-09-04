import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePin, previewPinterestPin, publishPinterestPin, listPinterestBoards } from '../dist/services/pinterest.js';

test('Pinterest validation, preview binding and publish mock', async () => {
  const original = globalThis.fetch;
  process.env.PINTEREST_ACCESS_TOKEN = 'test-only';
  process.env.PINTEREST_SANDBOX = 'true';
  const pin = { boardId:'123', title:'Title', imageUrl:'https://cdn.example.com/image.jpg', link:'https://shop.example.com/product' };
  let posts = 0;
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://api-sandbox.pinterest.com/v5/'));
    if (options.method === 'POST') { posts++; assert.equal(JSON.parse(options.body).media_source.source_type, 'image_url'); return Response.json({id:'456'}); }
    if (String(url).includes('user_account')) return Response.json({username:'test-account',account_type:'BUSINESS'});
    if (String(url).includes('boards?')) return Response.json({items:[],bookmark:'next'});
    return Response.json({id:'123',name:'Test board',privacy:'PUBLIC'});
  };
  try {
    assert.throws(() => normalizePin({...pin,imageUrl:'http://localhost/a'}));
    assert.throws(() => normalizePin({...pin,title:'a'.repeat(101)}));
    const p = await previewPinterestPin(pin);
    assert.equal(posts,0);
    await assert.rejects(publishPinterestPin({...pin,approval:'yes',previewHash:p.previewHash}));
    await assert.rejects(publishPinterestPin({...pin,title:'Changed',approval:'SON ONAY: YAYINLA',previewHash:p.previewHash}));
    assert.equal(posts,0);
    const result = await publishPinterestPin({...pin,approval:'SON ONAY: YAYINLA',previewHash:p.previewHash});
    assert.equal(result.pinId,'456'); assert.equal(posts,1);
    assert.equal((await listPinterestBoards()).bookmark,'next');
    globalThis.fetch = async () => new Response('',{status:403});
    await assert.rejects(listPinterestBoards(),/403/);
  } finally { globalThis.fetch=original; delete process.env.PINTEREST_ACCESS_TOKEN; delete process.env.PINTEREST_SANDBOX; }
});
