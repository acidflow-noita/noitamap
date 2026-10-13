export type LiquidProbeBounds = { left: number; right: number; top: number; bottom: number; planes: number };

/** Conservative bounds of the existing liquid probe rule, derived once from
 * its packed input records. They only cull GPU work; the shader still makes
 * every material/ownership decision. Coordinates repeat on the map pitch. */
export function liquidProbeBounds(table: { data: Float32Array; width: number; liquidRow: number }, columns: number): LiquidProbeBounds[] {
  const { data } = table, base = table.liquidRow * table.width * 4;
  const result = new Map<string, LiquidProbeBounds>();
  for (let chunk = 0; chunk < columns * 48; chunk++) {
    const header = base + chunk * 4, planes = data[header + 2] & 7, reach = data[header + 2] >> 3;
    if (!planes) continue;
    for (let n = 0; n < data[header + 1]; n++) {
      const record = base + (data[header] + 2 * n) * 4;
      const left = data[record], right = data[record + 1], top = data[record + 2];
      const bottom = Math.max(top, data[record + 4]) + reach;
      const key = `${left}/${right}/${top}/${bottom}`;
      const existing = result.get(key);
      if (existing) existing.planes |= planes;
      else result.set(key, { left, right, top, bottom, planes });
    }
  }
  return [...result.values()];
}
