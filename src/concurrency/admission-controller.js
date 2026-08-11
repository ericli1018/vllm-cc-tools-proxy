import { Semaphore } from './semaphore.js';

export class AdmissionController {
  constructor({ visionLimit = 1, webFetchProcessorLimit = 3 } = {}) {
    this.vision = new Semaphore(visionLimit);
    this.webFetchProcessor = new Semaphore(webFetchProcessorLimit);
  }

  acquireVision(options) { return this.vision.acquire(options); }
  acquireWebFetchProcessor(options) { return this.webFetchProcessor.acquire(options); }

  health() {
    return {
      vision: this.vision.health(),
      webFetchProcessor: this.webFetchProcessor.health(),
    };
  }
}
