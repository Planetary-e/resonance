/** A deliberately simple observer that pairs events by timestamp order only. */
export function pairByTimestamp(inputs: readonly number[], outputs: readonly number[]): number[] {
  if (!inputs.length || inputs.length !== outputs.length
    || [...inputs, ...outputs].some(time => !Number.isFinite(time))) {
    throw new Error('Timing observations must be finite and have equal nonzero counts');
  }
  const ordered = (values: readonly number[]) => values.map((time, index) => ({ time, index }))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const sources = ordered(inputs);
  const guesses: number[] = [];
  ordered(outputs).forEach((output, rank) => { guesses[output.index] = sources[rank].index; });
  return guesses;
}

export interface TimedTruth { atMs: number; truth: string }

/** Ground truth is available to scoring, never to the attack above. */
export function scoreTimingCorrelation(inputs: readonly TimedTruth[], outputs: readonly TimedTruth[]) {
  const inputTruth = new Set(inputs.map(item => item.truth));
  const outputTruth = new Set(outputs.map(item => item.truth));
  if (inputTruth.size !== inputs.length || outputTruth.size !== outputs.length
    || inputTruth.size !== outputTruth.size || [...inputTruth].some(id => !outputTruth.has(id))) {
    throw new Error('Timing trace has missing or duplicate ground truth');
  }
  const guesses = pairByTimestamp(inputs.map(item => item.atMs), outputs.map(item => item.atMs));
  const correct = guesses.filter((inputIndex, outputIndex) =>
    inputs[inputIndex].truth === outputs[outputIndex].truth).length;
  return { correct, total: outputs.length, accuracy: correct / outputs.length,
    randomPairingAccuracy: 1 / outputs.length };
}
