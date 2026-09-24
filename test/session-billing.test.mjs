import test from 'node:test';
import assert from 'node:assert/strict';
import { createCuaSession } from '../src/index.mjs';
import { createMeteredFetch, summarizeBilling } from '../src/meter.mjs';

const target = { getObservation: async () => ({url:'https://example.com/',title:'Done',text:'Verified',elements:[]}), click:async()=>{} };
const plan = {target,goal:'Check completion',actions:[{id:'open',action:'click',description:'Open permitted page'}],completion:{textIncludes:'Verified'}};
function response(tokens=10048) {return new Response(JSON.stringify({model:'jev-1.13.0',usage:{input_tokens:tokens,output_tokens:21},answers:{operation:{type:'choice',choice:'DONE',confidence:1,probabilities:{DONE:1,BLOCKED:0,open:0}}}}),{status:200,headers:{'content-type':'application/json'}});}

test('session meters each request once and separates list-price estimate from cash and host cost',async()=>{
  let calls=0;
  const session=await createCuaSession({apiKey:'not-a-real-secret',fetchImpl:async()=>{calls++;return response();}});
  const result=await session.goal(plan);
  assert.equal(result.status,'completed');
  const bill=await session.flushBilling();
  assert.equal(calls,1);assert.equal(bill.calls,1);
  assert.equal(bill.inputTokens,10048);assert.equal(bill.outputTokens,21);
  assert.ok(Math.abs(bill.estimatedJevUsd-0.000422016)<1e-12);
  assert.equal(bill.cashChargeUsd,null);assert.equal(bill.hostCostUsd,null);
  assert.equal(bill.complete,true);
  assert.equal(session.billingRecords()[0].model,'jev-1.13.0');
  assert.ok(!JSON.stringify([bill,session.billingRecords()]).includes('not-a-real-secret'));
});

test('network failures retain unknown charge rather than reporting zero',async()=>{
  const session=await createCuaSession({apiKey:'offline',fetchImpl:async()=>{throw new Error('secret transport diagnostic');}});
  await session.goal(plan);
  const bill=await session.flushBilling();
  assert.equal(bill.calls,1);assert.equal(bill.inputTokens,null);assert.equal(bill.estimatedJevUsd,null);assert.equal(bill.complete,false);
  assert.equal(bill.knownInputTokens,0);assert.ok(!JSON.stringify(bill).includes('secret'));
});

test('no dispatched API call is zero JEV usage with unknown host cost',async()=>{
  const session=await createCuaSession({maxCalls:0});
  const bill=session.billingStats();
  assert.equal(bill.calls,0);assert.equal(bill.estimatedJevUsd,0);assert.equal(bill.hostCostUsd,null);
});

test('overflowed usage subtotal remains unknown rather than zero dollars',async()=>{
  const meter=createMeteredFetch({fetchImpl:async()=>response(Number.MAX_SAFE_INTEGER)});
  await meter.fetchImpl('https://api.typesafe.ai/v1/systemone');
  await meter.fetchImpl('https://api.typesafe.ai/v1/systemone');
  const bill=summarizeBilling(await meter.flush());
  assert.equal(bill.knownInputTokens,null);
  assert.equal(bill.knownUsageUsd,null);
  assert.equal(bill.estimatedJevUsd,null);
});
