/** Each Wang rectangle keeps its original size and seed. A disconnected
 * piece inside a previously generated rectangle samples that earlier tile field. */
export function assignOverlappingWangChunks(regions: [number, number][][], bounds: [number, number, number, number][]) {
  for (let i = 1; i < regions.length; i++) {
    const points = regions[i];
    let kept = 0;
    for (const point of points) {
      const [x, y] = point;
      let owner = 0;
      while (owner < i) {
        const [left, top, right, bottom] = bounds[owner];
        if (x >= left && x <= right && y >= top && y <= bottom) break;
        owner++;
      }
      if (owner === i) points[kept++] = point;
      else regions[owner].push(point);
    }
    points.length = kept;
  }
}
