import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { correctTerrainShaderBits, POLKA_FLOAT_BITS } from "../build_scripts/vite-terrain-shaders";
const root=resolve(import.meta.dirname,"..");
const original=readFileSync(resolve(root,"lib/noita-telescope-vm/js/gl/shaders.js"),"utf8");
const float=(bits:number)=>new Float32Array(new Uint32Array([bits]).buffer)[0];
const bits=(value:number)=>new Uint32Array(new Float32Array([value]).buffer)[0];
describe("Noita rare-material shader constants",()=>{
 it("uses the binary's exact constants, also used by the CPU port",()=>{
  const cpu=readFileSync(resolve(root,"lib/noita-telescope-vm/js/engine_resolve/band_select.js"),"utf8");
  for(const value of Object.values(POLKA_FLOAT_BITS))expect(cpu).toContain(`0x${value.toString(16)}`);
  expect(float(POLKA_FLOAT_BITS.PK_SCALAR)).toBe(0.00101319863460958);
  const fixed=correctTerrainShaderBits(original);
  for(const [name,value] of Object.entries(POLKA_FLOAT_BITS))expect(fixed).toContain(`const float ${name} = uintBitsToFloat(0x${value.toString(16)}u);`);
  expect(correctTerrainShaderBits(fixed)).toBe(fixed);
 });
 it("regresses the wrong upstream values rather than pretending this is ordinary float rounding",()=>{
  // Recorded from the hosted terrain shader before this fix.
  for(const [name,value] of Object.entries({PK_SCALAR:0.0010132591396197677,PK_V0:0.0010514580644667149,PK_V1:0.0015553091652691364,PK_V2:0.0012450951617211103}))
   expect(bits(value)).not.toBe(POLKA_FLOAT_BITS[name as keyof typeof POLKA_FLOAT_BITS]);
 });
});
