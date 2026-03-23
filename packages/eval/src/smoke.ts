import { EmbeddingEngine, perturbVector, cosineSimilarity, l2Norm, normalize } from '@resonance/core';
import { HnswIndex } from '@resonance/relay';

async function smoke() {
  console.log('Resonance Smoke Test\n');

  // 1. Embedding engine
  console.log('[1/5] Initializing embedding engine...');
  const engine = new EmbeddingEngine();
  await engine.initialize();
  console.log('      OK');

  // 2. Embed a sentence
  console.log('[2/5] Embedding test sentence...');
  const vec = await engine.embed('I need a freelance developer');
  console.log(`      OK — ${vec.length} dimensions, L2 norm: ${l2Norm(vec).toFixed(4)}`);

  // 3. Perturb it
  console.log('[3/5] Perturbation at ε=1.0...');
  const { perturbed } = perturbVector(vec, 1.0);
  const sim = cosineSimilarity(vec, perturbed);
  console.log(`      OK — similarity to original: ${sim.toFixed(4)}`);

  // 4. HNSW index
  console.log('[4/5] HNSW index (100 vectors)...');
  const index = new HnswIndex({ maxElements: 200 });
  index.initialize();
  for (let i = 0; i < 100; i++) {
    const rv = new Float32Array(768);
    for (let j = 0; j < 768; j++) rv[j] = Math.random() - 0.5;
    index.addVector(normalize(rv), { did: `did:test:${i}`, itemType: 'offer', itemId: `${i}` });
  }
  index.addVector(perturbed, { did: 'did:test:query', itemType: 'need', itemId: 'q' });
  const results = index.search(perturbed, 3, 0.0);
  console.log(`      OK — top result similarity: ${results[0]?.similarity.toFixed(4)}`);

  // 5. Semantic match test
  console.log('[5/5] Semantic matching...');
  const need = await engine.embed('Looking for a Python developer for web work', 'search_query');
  const offer = await engine.embed('Python developer available for freelance projects', 'search_document');
  const matchSim = cosineSimilarity(need, offer);
  console.log(`      OK — need/offer similarity: ${matchSim.toFixed(4)}`);

  console.log('\nAll components operational ✓\n');
}

smoke().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
