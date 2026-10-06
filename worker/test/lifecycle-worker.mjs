// Explicit Kubernetes lifecycle fixture: never joins a provider or claims audio proof.
import {randomUUID} from 'node:crypto';
import {serviceRequest} from '../dist-worker/http.js';

const workerId = randomUUID();
const api = process.env.WORTLAUT_API_URL;
const attempt = process.env.WORTLAUT_ATTEMPT_ID;
const headers = {Authorization: `Bearer ${process.env.WORTLAUT_BOOTSTRAP_CREDENTIAL}`,
  'X-Worker-ID': workerId, 'Content-Type': 'application/json'};
const post = async (suffix, body) => {
  return serviceRequest(new URL(`/v1/attempts/${attempt}/${suffix}`, api), {
    method: 'POST', headers, body: JSON.stringify(body)});
};

await post('claim', {worker_id: workerId});
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
console.log('lifecycle fixture claimed; no provider connection');
while (!stopping) {
  const reply = await post('status', {participation: 'joining'});
  if (reply.stop_requested) { stopping = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await post('status', {participation: 'ended', reason: 'cancelled'});
console.log('lifecycle fixture stopped');
