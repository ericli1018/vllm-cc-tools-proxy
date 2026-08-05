import { ManagedQueue } from './managed-queue.js';
import { Semaphore } from './semaphore.js';

export class AdmissionController {
  constructor({ managedLimit, queueLimit, queueTimeoutMs, visionLimit }) {
    this.managed = new ManagedQueue({ limit: managedLimit, queueLimit, timeoutMs: queueTimeoutMs });
    this.vision = new Semaphore(visionLimit);
    this.ingress = new Semaphore(8);
  }

  acquireManaged(options) {
    return this.managed.acquire(options);
  }

  acquireVision(options) {
    return this.vision.acquire(options);
  }

  acquireIngress(options) {
    return this.ingress.acquire(options);
  }

  canAcceptManaged() {
    return this.managed.canAccept();
  }

  health() {
    return { managed: this.managed.health(), vision: this.vision.health() };
  }
}
