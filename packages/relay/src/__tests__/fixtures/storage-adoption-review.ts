import { openRelayStorageAdoptionReview } from '../../relay-storage-adoption.js';
const review = await openRelayStorageAdoptionReview(JSON.parse(process.argv[2]));
process.send?.(review.review().approvalDigest);
process.once('disconnect', () => review.close());
