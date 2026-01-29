/**
 * Type declarations for @wtsml/doodle
 */

declare module '@wtsml/doodle' {
  interface DoodleOptions {
    viewer: OpenSeadragon.Viewer;
    onAdd?: (shape: any) => void;
    onRemove?: (shape: any) => void;
    onUpdate?: (shape: any) => void;
    onSelect?: (shape: any) => void;
    onCancelSelect?: (shape: any) => void;
  }

  export function createDoodle(options: DoodleOptions): any;
}
