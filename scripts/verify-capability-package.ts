import { readFile } from 'node:fs/promises';
import { CapabilityRegistry, capabilityRegistry, type CapabilityDescriptor } from '../src/system/capabilities.js';

const path=process.argv[2];if(!path)throw new Error('capability package path is required');
const raw=JSON.parse(await readFile(path,'utf8')) as {format_version?:number;version?:string;capabilities?:CapabilityDescriptor[]};
if(raw.format_version!==1||!/^\d+\.\d+\.\d+$/.test(String(raw.version??''))||!Array.isArray(raw.capabilities)||!raw.capabilities.length)throw new Error('invalid capability package');
const registry=new CapabilityRegistry(raw.capabilities);
for(const descriptor of registry.all()){
  const trusted=capabilityRegistry.get(descriptor.id);if(!trusted||JSON.stringify(trusted)!==JSON.stringify(descriptor))throw new Error(`untrusted capability descriptor: ${descriptor.id}`);
  if(!descriptor.implemented||descriptor.access==='external')throw new Error(`capability is not eligible for local safe install: ${descriptor.id}`);
  for(const dependency of descriptor.dependencies)if(!capabilityRegistry.get(dependency))throw new Error(`unknown dependency: ${dependency}`);
}
console.log(`verified ${registry.all().length} capability descriptor(s)`);
