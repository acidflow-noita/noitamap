/** Host policy in the terrain shader, including material-ID reads for decals.
 * Extra records share the engine table; no extra texture units are required. */
export function hostTerrainShader(source: string): string {
  const anchor = 'export const TERRAIN_FS = TERRAIN_FS_LIB + `';
  if (!source.includes(anchor)) throw new Error('Unknown Telescope terrain shader');
  source = source.replace(anchor, anchor + `
uniform int u_hostTable;
vec4 hostRecord(int i) {
    int width = textureSize(u_engTableTex, 0).x;
    return texelFetch(u_engTableTex, ivec2(i % width, i / width), 0);
}
vec4 hostCell(ivec2 w) {
    int width = u_mapWidth;
    int x = fdiv(w.x + u_centerPx, 512);
    x = ((x % width) + width) % width;
    int y = fdiv(w.y + u_baseY, 512);
    if (y < 0 || y >= 48) return vec4(0.0);
    return hostRecord(u_hostTable + y * width + x);
}
int hostRawMaterial(ivec2 w) {
    if (u_hostTable != 0 && hostCell(w).x == 0.0) return -1;
    ivec2 cell = engResolveCell(w);
    uint info = engInfoAt(cell.x, cell.y);
    uint mode = (info >> 8) & 3u;
    if ((info & 2048u) != 0u || mode == 2u) return 0;
    int slot = int(info & 255u);
    if (mode == 1u) return engTopo2(slot, w);
    int x = fdiv(w.x + u_centerPx, 512), y = fdiv(w.y + u_baseY, 512);
    return engTopo0(slot, int(engInfoAt(x, y) & 255u), int(engInfoAt(x-1, y) & 255u), w);
}
int hostLiquid(int mat, ivec2 w) {
    if (u_hostTable == 0) return mat;
    vec4 cell = hostCell(w);
    int width = u_mapWidth * 512;
    int x = ((w.x + u_centerPx) % width + width) % width - u_centerPx;
    for (int i = 0; i < int(cell.z); ++i) {
        vec4 s = hostRecord(int(cell.y) + i);
        if (x < int(s.x) || x >= int(s.y) || w.y < int(s.z)-6 || w.y >= int(s.z)+6) continue;
        int liquid = int(s.w);
        if (mat != 0 && mat != liquid) continue;
        if (w.y < int(s.z)) { if (mat == liquid) mat = 0; }
        else if (mat == 0 && hostRawMaterial(ivec2(w.x, int(s.z)+6)) == liquid) mat = liquid;
    }
    return mat;
}
`);
  const position = 'g_sub = off - floor(off);';
  source = source.replace(position, position + `
    if (u_hostTable != 0 && hostCell(w).x == 0.0) {
        outColor = u_materialIdOut ? vec4(1.0/255.0, 0.0, 0.0, 1.0) : vec4(0.0);
        return;
    }
`);
  source = source.replace('int code = mat + 1;', 'mat = hostLiquid(mat, w);\n            int code = mat + 1;');
  source = source.replace('if (mat > 0) engMaterialColor(mat, w);', 'mat = hostLiquid(mat, w);\n            if (mat > 0) engMaterialColor(mat, w);');
  return source;
}

export function hostDecalDetail(source: string): string {
  const anchor = 'const drawing = view.camZ >= EDGE_DECAL_MIN_ZOOM;';
  if (!source.includes(anchor)) throw new Error('Unknown Telescope decal zoom gate');
  return source.replace(anchor, 'const drawing = (view.detailZoom ?? view.camZ) >= EDGE_DECAL_MIN_ZOOM;')
    .replace('const ring = drawing ? PREFETCH_RING : 0;', 'const ring = view.detailZoom === Infinity ? 0 : (drawing ? PREFETCH_RING : 0);');
}
