declare module "*.wasm" {
  const content: string;
  export default content;
}

declare module "./vtracer_webapp_bg.js" {
  export class BinaryImageConverter {
    free(): void;
    init(): void;
    static new_with_string(params: string): BinaryImageConverter;
    progress(): number;
    tick(): boolean;
  }

  export class ColorImageConverter {
    free(): void;
    init(): void;
    static new_with_string(params: string): ColorImageConverter;
    progress(): number;
    tick(): boolean;
  }

  export function main(): void;
  export function __wbg_set_wasm(val: any): void;
  export function __wbindgen_init_externref_table(): void;
}
