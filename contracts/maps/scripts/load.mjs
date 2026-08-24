import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../lib/contracts.mjs";

export const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const projectRoot=join(root,"..","..");

export async function loadBundle(){
  const [sources,pricing,capabilities,costModel,manifests,storage,credentials,admission,degradation,golden]=await Promise.all([
    readJson(join(root,"catalog","sources.json")),readJson(join(root,"catalog","pricing.json")),readJson(join(root,"catalog","capabilities.json")),readJson(join(root,"catalog","cost-model.json")),readJson(join(root,"manifests","request-manifests.json")),readJson(join(root,"catalog","storage-display-policy.json")),readJson(join(root,"catalog","credential-project-policy.json")),readJson(join(root,"catalog","admission-policy.json")),readJson(join(root,"scenarios","degradation.json")),readJson(join(root,"scenarios","golden-examples.json"))
  ]);
  return{sources,pricing,capabilities,costModel,manifests,storage,credentials,admission,degradation,golden};
}

export async function loadProfiles(){
  return Promise.all(["small-pilot","p0-growth","enterprise-design","commercial-platform"].map((id)=>readJson(join(projectRoot,"benchmarks","workloads","profiles",`${id}.json`))));
}
