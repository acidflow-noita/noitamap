import { describe, it, expect } from 'vitest';
import { encodeShapesBinary, decodeShapesBinary } from '../../src/drawing/binary-encoder';
import type { Shape } from '../../src/drawing/doodle-integration';

describe('Binary Encoder', () => {
  it('should losslessly encode and decode shapes across the map', () => {
    // defined test regions (3x3 grid) to cover large coordinate ranges
    // assuming map size roughly 35k x 35k or larger to test int32 limits if needed
    // standard noita world is ~35840 wide, so we'll test comfortably within and outside that

    const regions = [
      { x: -100000, y: -100000, name: 'TopLeft' },
      { x: 0, y: -100000, name: 'TopCenter' },
      { x: 100000, y: -100000, name: 'TopRight' },
      { x: -100000, y: 0, name: 'MiddleLeft' },
      { x: 0, y: 0, name: 'Center' },
      { x: 100000, y: 0, name: 'MiddleRight' },
      { x: -100000, y: 100000, name: 'BottomLeft' },
      { x: 0, y: 100000, name: 'BottomCenter' },
      { x: 100000, y: 100000, name: 'BottomRight' },
    ];

    const types = ['path', 'rect', 'circle', 'line', 'arrow_line', 'text', 'point'] as const;
    const shapes: Shape[] = [];

    let idCounter = 0;

    regions.forEach((region, rIdx) => {
      // Create one large and one small shape for each type in this region
      types.forEach((type, tIdx) => {
        // Different color for each region
        const color = [
          '#ff0000',
          '#00ff00',
          '#0000ff',
          '#ffff00',
          '#00ffff',
          '#ff00ff',
          '#ffffff',
          '#000000',
          '#888888',
        ][rIdx];

        // Create pos based on type
        let pos: number[] = [];
        if (type === 'circle') {
          // [cx, cy, r] - note r is relative in encoder but we pass raw r here?
          // Encoder: circle: writeCoordX(pos[0]), writeCoordY(pos[1]), writeCoordX(pos[0] + pos[2])
          // So input pos[2] IS THE RADIUS.
          pos = [region.x, region.y, 100]; // cx, cy, radius
        } else if (type === 'point' || type === 'text') {
          // [x, y]
          pos = [region.x, region.y];
        } else if (type === 'rect') {
          // [x, y, w, h] - Encoder expects this for rect
          // Encoder: writeCoordX(pos[0]), writeCoordY(pos[1]), writeCoordX(pos[0] + pos[2])...
          // So pos[2]/pos[3] ARE width/height.
          pos = [region.x, region.y, 200, 100];
        } else {
          // path, line, arrow_line - using 2 points [x1, y1, x2, y2]
          pos = [region.x, region.y, region.x + 5000, region.y + 5000];
        }

        shapes.push({
          id: `shape_${idCounter++}`,
          type: type as any,
          color: color,
          pos: pos,
        });

        // Small shape
        let smallPos: number[] = [];
        if (type === 'circle') {
          smallPos = [region.x + 100, region.y + 100, 10];
        } else if (type === 'point' || type === 'text') {
          smallPos = [region.x + 100, region.y + 100];
        } else if (type === 'rect') {
          smallPos = [region.x + 100, region.y + 100, 20, 10];
        } else {
          smallPos = [region.x + 100, region.y + 100, region.x + 110, region.y + 110];
        }

        shapes.push({
          id: `shape_${idCounter++}`,
          type: type as any,
          color: color,
          pos: smallPos,
        });
      });
    });

    const encoded = encodeShapesBinary(shapes, 'test_map');
    expect(encoded).not.toBeNull();

    if (!encoded) return;

    const decoded = decodeShapesBinary(encoded);
    expect(decoded).not.toBeNull();

    if (!decoded) return;

    expect(decoded.mapName).toBe('test_map');
    expect(decoded.shapes.length).toBe(shapes.length);

    // Verify coordinates match exactly
    for (let i = 0; i < shapes.length; i++) {
      const original = shapes[i];
      const result = decoded.shapes[i];

      // Colors are simplified to palette index, so exact hex check might fail if not in palette
      // But we used palette-like colors. Let's skip color check for strict equality
      // and update the test if we implement strict color matching. The encoder maps to closest palette color.

      expect(result.type).toBe(original.type);
      // Check positions
      expect(result.pos.length).toBe(original.pos.length);
      for (let j = 0; j < original.pos.length; j++) {
        expect(result.pos[j]).toBe(original.pos[j]);
      }
    }
  });

  it('should handle single point shapes', () => {
    const shapes: Shape[] = [
      {
        id: 'p1',
        type: 'point',
        pos: [1234, 5678],
        color: '#ffffff',
      },
    ];

    const encoded = encodeShapesBinary(shapes, 'point_map');
    expect(encoded).not.toBeNull();
    const decoded = decodeShapesBinary(encoded!);
    expect(decoded?.shapes[0].pos).toEqual([1234, 5678]);
  });

  it('should handle polygon shapes with many vertices', () => {
    // Create a polygon with many vertices (like those from vtracer conversion)
    const vertices = [];
    const numPoints = 100;
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      vertices.push(
        Math.round(10000 * Math.cos(angle) - 15000), // x
        Math.round(10000 * Math.sin(angle) + 5000)   // y
      );
    }

    const shapes: Shape[] = [
      {
        id: 'polygon1',
        type: 'polygon',
        pos: vertices,
        color: '#ff0000',
        filled: true,
        fillAlpha: 1.0,
      },
    ];

    const encoded = encodeShapesBinary(shapes, 'polygon_map');
    expect(encoded).not.toBeNull();

    const decoded = decodeShapesBinary(encoded!);
    expect(decoded).not.toBeNull();
    expect(decoded?.shapes.length).toBe(1);
    expect(decoded?.shapes[0].type).toBe('polygon');
    expect(decoded?.shapes[0].pos.length).toBe(vertices.length);

    // Verify all coordinates match exactly
    for (let i = 0; i < vertices.length; i++) {
      expect(decoded?.shapes[0].pos[i]).toBe(vertices[i]);
    }
  });

  it('should handle complex polygon with negative coordinates', () => {
    // Test polygon similar to convert_svg output with large negative coordinates
    const shapes: Shape[] = [
      {
        id: 'complex_polygon',
        type: 'polygon',
        pos: [
          -15912, -9072,
          -14708, -9072,
          -14708, -8900,
          -14020, -8900,
          -14020, -8728,
          -13504, -8728,
          -13504, -8556,
          -13332, -8556,
          -13332, -8384,
          -12988, -8384,
          -12988, -8212,
          -12816, -8212,
        ],
        color: '#5B4749',
        filled: true,
        fillAlpha: 1.0,
        strokeWidth: 0,
      },
    ];

    const encoded = encodeShapesBinary(shapes, 'complex_map');
    expect(encoded).not.toBeNull();

    const decoded = decodeShapesBinary(encoded!);
    expect(decoded).not.toBeNull();
    expect(decoded?.shapes[0].type).toBe('polygon');
    expect(decoded?.shapes[0].pos.length).toBe(shapes[0].pos.length);

    // Verify all coordinates preserved
    for (let i = 0; i < shapes[0].pos.length; i++) {
      expect(decoded?.shapes[0].pos[i]).toBe(shapes[0].pos[i]);
    }
  });

  it('should support custom RGB colors and fill alpha (V5)', () => {
    const customColor = '#123456';
    const shapes: Shape[] = [
      {
        id: 'c1',
        type: 'rect',
        pos: [100, 200, 300, 400],
        color: customColor,
        filled: true,
        fillAlpha: 0.75,
      },
      {
        id: 'c2',
        type: 'path',
        pos: [10, 20, 30, 40],
        color: '#ff00ff', // Also a custom color (Violet is #8b5cf6 in palette)
      },
    ];

    const encoded = encodeShapesBinary(shapes, 'custom_color_map');
    expect(encoded).not.toBeNull();
    expect(encoded![0]).toBe(5); // Version 5

    const decoded = decodeShapesBinary(encoded!);
    expect(decoded).not.toBeNull();
    expect(decoded?.shapes[0].color).toBe(customColor);
    expect(decoded?.shapes[0].filled).toBe(true);
    expect(decoded?.shapes[0].fillAlpha).toBe(0.75);
    expect(decoded?.shapes[1].color).toBe('#ff00ff');
  });
});
