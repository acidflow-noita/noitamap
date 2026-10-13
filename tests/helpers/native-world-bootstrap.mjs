import {register} from 'tsx/esm/api';
import {workerData} from 'node:worker_threads';
register();
await import(workerData.entry);
