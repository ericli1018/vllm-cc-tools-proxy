import test from "node:test";
import assert from "node:assert/strict";
import { DirectedVisualStore, buildDirectedPlanningRequest, parseDirectedPlanningResponse } from "../src/visual/directed-vision.js";

test("V0.29.46 directed visual store is request-local and planning covers every asset", () => {
  const store = new DirectedVisualStore();
  const a = store.register({ buffer: Buffer.from("a"), mediaType: "image/png", width: 10, height: 10 });
  const b = store.register({ buffer: Buffer.from("b"), mediaType: "image/png", width: 20, height: 20 });
  const request = buildDirectedPlanningRequest({ model:"m",stream:true,messages:[{role:"user",content:"inspect"}],tools:[{name:"Bash"}] }, store);
  assert.equal(request.stream,false);
  assert.equal("tools" in request,false);
  assert.doesNotMatch(JSON.stringify(request),/VisualInspect/);
  const plan = parseDirectedPlanningResponse({content:[{type:"text",text:JSON.stringify({schema:"visual_perception_plan_v1",assets:[
    {asset_id:a.assetId,objective:"inspect a",questions:[{id:"a1",question:"what is visible?"}]},
    {asset_id:b.assetId,objective:"inspect b",questions:[{id:"b1",question:"what is visible?"}]},
  ]})}]},store);
  assert.equal(plan.assets.length,2);
  store.clear();
  assert.equal(store.size,0);
});
