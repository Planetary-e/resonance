/** Reproducible synthetic privacy/quality probe for scoped LSH epochs. */
import {
  getScopedProjectionMatrixV2, getSharedProjectionMatrix,
  hashEmbedding, hammingSimilarity,
} from '@resonance/core';

const legacy = getSharedProjectionMatrix();
const september = getScopedProjectionMatrixV2('barcelona', '2026-09');
const october = getScopedProjectionMatrixV2('barcelona', '2026-10');
const otherGroup = getScopedProjectionMatrixV2('madrid', '2026-09');
const sampleCount = 64;
const threshold = 0.65;
const rows = {
  legacyNeighbor: [] as number[], scopedNeighbor: [] as number[],
  otherGroupSame: [] as number[], nextEpochSame: [] as number[],
  nextEpochNeighbor: [] as number[],
};

for (let sample = 0; sample < sampleCount; sample++) {
  const vector = Float32Array.from({ length: 768 }, (_, dimension) =>
    Math.sin((dimension + 1) * (sample + 3) * 0.017)
      + Math.cos((dimension + 7) * (sample + 1) * 0.031));
  const neighbor = Float32Array.from(vector, (value, dimension) =>
    value + 0.18 * Math.sin((dimension + 11) * (sample + 5) * 0.047));
  const old = hashEmbedding(vector, legacy);
  const oldNeighbor = hashEmbedding(neighbor, legacy);
  const current = hashEmbedding(vector, september);
  const currentNeighbor = hashEmbedding(neighbor, september);
  rows.legacyNeighbor.push(hammingSimilarity(old, oldNeighbor));
  rows.scopedNeighbor.push(hammingSimilarity(current, currentNeighbor));
  rows.otherGroupSame.push(hammingSimilarity(current, hashEmbedding(vector, otherGroup)));
  rows.nextEpochSame.push(hammingSimilarity(current, hashEmbedding(vector, october)));
  rows.nextEpochNeighbor.push(hammingSimilarity(current, hashEmbedding(neighbor, october)));
}

const report = Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, {
  meanSimilarity: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)),
  matchesAtThreshold: values.filter(value => value >= threshold).length,
  sampleCount,
}]));
console.log(JSON.stringify({
  note: 'Deterministic synthetic vectors only; this does not measure semantic recall on real text.',
  threshold,
  report,
}, null, 2));
